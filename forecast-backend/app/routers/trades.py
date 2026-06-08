# app/routers/portfolio.py
from fastapi import APIRouter, Depends
from sqlalchemy import select, desc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from .. import models
from ..models import Position, Market, Trade, User
from ..database import get_db
from ..security import get_current_user
from ..lmsr import lmsr_prices

router = APIRouter(tags=["portfolio"])


@router.get("/me/portfolio")
async def portfolio(user: models.User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    positions = (await db.execute(select(Position).where(Position.user_id == user.id))).scalars().all()
    market_ids = {p.market_id for p in positions}
    markets = {}
    if market_ids:
        ms = (await db.execute(
            select(Market).where(Market.id.in_(market_ids)).options(selectinload(Market.outcomes))
        )).scalars().all()
        markets = {m.id: m for m in ms}

    rows, pos_value, unreal = [], 0.0, 0.0
    for p in positions:
        m = markets.get(p.market_id)
        if not m:
            continue
        prices = lmsr_prices([o.shares_outstanding for o in m.outcomes], m.liquidity_param)
        idx = next(i for i, o in enumerate(m.outcomes) if o.id == p.outcome_id)
        cur = prices[idx]
        value = p.shares * cur
        u = value - p.shares * p.avg_price
        pos_value += value
        unreal += u
        rows.append({
            "market_id": m.id, "question": m.question, "outcome_id": p.outcome_id,
            "outcome_label": m.outcomes[idx].label, "shares": p.shares,
            "avg_price": p.avg_price, "cur_price": cur, "value": value, "unrealized_pnl": u,
        })

    return {
        "net_worth": user.balance + pos_value, "cash": user.balance,
        "positions_value": pos_value, "unrealized_pnl": unreal,
        "realized_pnl": user.realized_pnl, "positions": rows,
    }


@router.get("/me/trades")
async def my_trades(user: models.User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    trades = (await db.execute(
        select(Trade).where(Trade.user_id == user.id).order_by(desc(Trade.created_at)).limit(50)
    )).scalars().all()
    mids = {t.market_id for t in trades}
    markets = {}
    if mids:
        ms = (await db.execute(
            select(Market).where(Market.id.in_(mids)).options(selectinload(Market.outcomes))
        )).scalars().all()
        markets = {m.id: m for m in ms}
    out = []
    for t in trades:
        m = markets.get(t.market_id)
        label = next((o.label for o in m.outcomes if o.id == t.outcome_id), None) if m else None
        out.append({
            "id": t.id, "market_id": t.market_id,
            "question": m.question if m else None, "outcome_label": label,
            "side": t.side, "shares": t.shares, "price": t.price, "cost": t.cost,
            "created_at": t.created_at,
        })
    return out


@router.get("/leaderboard")
async def leaderboard(db: AsyncSession = Depends(get_db)):
    users = (await db.execute(select(User))).scalars().all()
    positions = (await db.execute(select(Position))).scalars().all()
    markets = (await db.execute(select(Market).options(selectinload(Market.outcomes)))).scalars().all()

    pmap = {}
    for m in markets:
        prices = lmsr_prices([o.shares_outstanding for o in m.outcomes], m.liquidity_param)
        pmap[m.id] = (prices, {o.id: i for i, o in enumerate(m.outcomes)})

    holdings: dict[str, float] = {}
    for p in positions:
        entry = pmap.get(p.market_id)
        if not entry:
            continue
        prices, idxmap = entry
        i = idxmap.get(p.outcome_id)
        if i is None:
            continue
        holdings[p.user_id] = holdings.get(p.user_id, 0.0) + p.shares * prices[i]

    rows = []
    for u in users:
        net = u.balance + holdings.get(u.id, 0.0)
        rows.append({
            "id": u.id, "name": u.name, "avatar": u.avatar, "color": u.color,
            "net_worth": net, "profit": net - u.start_balance, "is_bot": u.is_bot,
        })
    rows.sort(key=lambda r: -r["net_worth"])
    return rows