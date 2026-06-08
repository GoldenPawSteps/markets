# app/routers/markets.py
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from .. import models, schemas, crud
from ..models import Market, Outcome, Trade, Comment, PricePoint, User, utcnow, as_utc
from ..database import get_db
from ..config import settings
from ..security import get_current_user
from ..lmsr import quote_trade
from ..ws import manager

router = APIRouter(prefix="/markets", tags=["markets"])


async def _load(db, market_id):
    m = (await db.execute(
        select(Market).where(Market.id == market_id).options(selectinload(Market.outcomes))
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(404, "Market not found")
    return m


@router.get("")
async def list_markets(
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(None, pattern="^(open|closed|resolved)$"),
    category: str | None = None,
    q: str | None = None,
    sort: str = Query("trending", pattern="^(trending|newest)$"),
    limit: int = Query(50, le=100),
    offset: int = 0,
):
    now = utcnow()
    stmt = select(Market).options(selectinload(Market.outcomes))
    if status == "resolved":
        stmt = stmt.where(Market.status == "resolved")
    elif status == "open":
        stmt = stmt.where(Market.status == "open", Market.close_date > now)
    elif status == "closed":
        stmt = stmt.where(Market.status == "open", Market.close_date <= now)
    if category and category != "All":
        stmt = stmt.where(Market.category == category)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(Market.question.ilike(like) | Market.description.ilike(like))
    stmt = stmt.order_by(desc(Market.created_at) if sort == "newest" else desc(Market.volume))
    stmt = stmt.limit(limit).offset(offset)
    markets = (await db.execute(stmt)).scalars().all()
    return [crud.build_market_out(m) for m in markets]


@router.post("")
async def create_market(
    body: schemas.MarketCreate,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if settings.admin_only_create and not user.is_admin:
        raise HTTPException(403, "Market creation is restricted to admins")
    labels = ["Yes", "No"] if body.type == "binary" else [l.strip() for l in body.outcomes if l.strip()]
    if body.type == "categorical" and len(labels) < 2:
        raise HTTPException(400, "Provide at least two outcomes")
    close = as_utc(body.close_date)
    if close <= utcnow():
        raise HTTPException(400, "Close date must be in the future")

    m = Market(
        question=body.question, description=body.description or "",
        category=body.category or "Other", type=body.type,
        liquidity_param=body.liquidity_param,
        resolution_criteria=body.resolution_criteria or "", created_by=user.id,
        close_date=close, status="open",
    )
    db.add(m)
    await db.flush()
    for i, label in enumerate(labels):
        db.add(Outcome(market_id=m.id, label=label, position=i, shares_outstanding=0.0))
    n = len(labels)
    db.add(PricePoint(market_id=m.id, prices=[1.0 / n] * n))
    await db.commit()

    m = await _load(db, m.id)
    out = crud.build_market_out(m)
    await manager.publish("feed", {"type": "market_created", "market": out})
    return out


@router.get("/{market_id}")
async def market_detail(market_id: str, db: AsyncSession = Depends(get_db)):
    m = await _load(db, market_id)
    creator = await db.get(User, m.created_by)
    label_by_id = {o.id: o.label for o in m.outcomes}

    history = (await db.execute(
        select(PricePoint).where(PricePoint.market_id == market_id)
        .order_by(PricePoint.ts).limit(400)
    )).scalars().all()
    trades = (await db.execute(
        select(Trade).where(Trade.market_id == market_id)
        .order_by(desc(Trade.created_at)).limit(20).options(selectinload(Trade.user))
    )).scalars().all()
    comments = (await db.execute(
        select(Comment).where(Comment.market_id == market_id)
        .order_by(desc(Comment.created_at)).options(selectinload(Comment.user))
    )).scalars().all()

    out = crud.build_market_out(m)
    out["creator"] = {"id": creator.id, "name": creator.name} if creator else None
    out["resolution_criteria"] = m.resolution_criteria
    out["history"] = [{"t": p.ts, "values": p.prices} for p in history]
    out["recent_trades"] = [
        {"id": t.id, "side": t.side, "shares": t.shares, "price": t.price,
         "outcome_id": t.outcome_id, "outcome_label": label_by_id.get(t.outcome_id),
         "created_at": t.created_at,
         "user": {"name": t.user.name, "avatar": t.user.avatar, "color": t.user.color}}
        for t in trades
    ]
    out["comments"] = [
        {"id": c.id, "text": c.text, "created_at": c.created_at,
         "user": {"name": c.user.name, "avatar": c.user.avatar, "color": c.user.color}}
        for c in comments
    ]
    return out


@router.get("/{market_id}/quote")
async def quote(
    market_id: str,
    outcome_id: str,
    side: str = Query(pattern="^(buy|sell)$"),
    shares: float = Query(gt=0),
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _load(db, market_id)
    idx = next((i for i, o in enumerate(m.outcomes) if o.id == outcome_id), -1)
    if idx < 0:
        raise HTTPException(404, "Outcome not found")
    pos = (await db.execute(
        select(models.Position).where(
            models.Position.user_id == user.id, models.Position.outcome_id == outcome_id
        )
    )).scalar_one_or_none()
    held = pos.shares if pos else 0.0
    q = quote_trade(
        [o.shares_outstanding for o in m.outcomes], m.liquidity_param,
        idx, side, shares, user.balance, held,
    )
    q["outcome_id"] = outcome_id
    q["outcome_label"] = m.outcomes[idx].label
    return q


@router.post("/{market_id}/resolve")
async def resolve(
    market_id: str,
    body: schemas.ResolveBody,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await db.get(Market, market_id)
    if m is None:
        raise HTTPException(404, "Market not found")
    if not (user.is_admin or m.created_by == user.id):
        raise HTTPException(403, "Only the creator or an admin can resolve this market")
    result = await crud.resolve_market(db, market_id, body.winning_outcome_id)
    msg = {"type": "market_resolved", **result}
    await manager.publish(f"market:{market_id}", msg)
    await manager.publish("feed", msg)
    return result


@router.get("/{market_id}/comments")
async def list_comments(market_id: str, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(Comment).where(Comment.market_id == market_id)
        .order_by(desc(Comment.created_at)).options(selectinload(Comment.user))
    )).scalars().all()
    return [
        {"id": c.id, "text": c.text, "created_at": c.created_at,
         "user": {"name": c.user.name, "avatar": c.user.avatar, "color": c.user.color}}
        for c in rows
    ]


@router.post("/{market_id}/comments")
async def add_comment(
    market_id: str,
    body: schemas.CommentCreate,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Market, market_id) is None:
        raise HTTPException(404, "Market not found")
    c = Comment(market_id=market_id, user_id=user.id, text=body.text)
    db.add(c)
    await db.commit()
    payload = {"id": c.id, "text": c.text, "created_at": c.created_at,
               "user": {"name": user.name, "avatar": user.avatar, "color": user.color}}
    await manager.publish(f"market:{market_id}", {"type": "comment", **payload})
    return payload