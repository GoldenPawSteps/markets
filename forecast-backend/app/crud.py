# app/crud.py
from __future__ import annotations
from datetime import datetime
from fastapi import HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from . import models
from .models import Market, Outcome, Position, Trade, PricePoint, User, utcnow
from .lmsr import lmsr_prices, cost_to_trade

EPS = 1e-9


def effective_status(m: Market, now: datetime | None = None) -> str:
    now = now or utcnow()
    if m.status == "resolved":
        return "resolved"
    return "closed" if m.close_date <= now else "open"


def prices_payload(outcomes: list[Outcome], b: float) -> list[dict]:
    prices = lmsr_prices([o.shares_outstanding for o in outcomes], b)
    return [
        {"outcome_id": o.id, "label": o.label, "price": prices[i],
         "shares_outstanding": o.shares_outstanding}
        for i, o in enumerate(outcomes)
    ]


def build_market_out(m: Market) -> dict:
    prices = lmsr_prices([o.shares_outstanding for o in m.outcomes], m.liquidity_param)
    return {
        "id": m.id, "question": m.question, "description": m.description,
        "category": m.category, "type": m.type, "status": effective_status(m),
        "close_date": m.close_date, "created_at": m.created_at, "volume": m.volume,
        "liquidity_param": m.liquidity_param, "created_by": m.created_by,
        "resolved_outcome_id": m.resolved_outcome_id,
        "outcomes": [
            {"id": o.id, "label": o.label, "price": prices[i],
             "shares_outstanding": o.shares_outstanding}
            for i, o in enumerate(m.outcomes)
        ],
    }


async def execute_trade(db: AsyncSession, user: User, market_id: str,
                        outcome_id: str, side: str, qty: float) -> dict:
    # 1) lock market, 2) lock outcomes, 3) lock user, 4) lock position
    market = (await db.execute(
        select(Market).where(Market.id == market_id).with_for_update()
    )).scalar_one_or_none()
    if market is None:
        raise HTTPException(404, "Market not found")
    if market.status == "resolved":
        raise HTTPException(400, "Market already resolved")
    if market.close_date <= utcnow():
        raise HTTPException(400, "Market is closed")

    outcomes = (await db.execute(
        select(Outcome).where(Outcome.market_id == market_id)
        .order_by(Outcome.position).with_for_update()
    )).scalars().all()
    idx = next((i for i, o in enumerate(outcomes) if o.id == outcome_id), -1)
    if idx < 0:
        raise HTTPException(404, "Outcome not found")
    if qty <= 0:
        raise HTTPException(400, "Quantity must be positive")

    locked_user = (await db.execute(
        select(User).where(User.id == user.id).with_for_update()
    )).scalar_one()
    pos = (await db.execute(
        select(Position).where(
            Position.user_id == user.id, Position.outcome_id == outcome_id
        ).with_for_update()
    )).scalar_one_or_none()

    shares = [o.shares_outstanding for o in outcomes]
    b = market.liquidity_param
    delta = qty if side == "buy" else -qty
    cost = cost_to_trade(shares, b, idx, delta)
    held = pos.shares if pos else 0.0

    if side == "buy" and cost > locked_user.balance + EPS:
        raise HTTPException(400, "Insufficient balance")
    if side == "sell" and qty > held + EPS:
        raise HTTPException(400, "Not enough shares to sell")

    per_share = abs(cost) / qty
    outcomes[idx].shares_outstanding += delta

    realized_delta = 0.0
    position_obj = pos
    if side == "buy":
        new_shares = held + qty
        prev_basis = (pos.shares * pos.avg_price) if pos else 0.0
        new_avg = (prev_basis + cost) / new_shares
        if pos:
            pos.shares, pos.avg_price = new_shares, new_avg
        else:
            position_obj = Position(
                user_id=user.id, market_id=market_id, outcome_id=outcome_id,
                shares=new_shares, avg_price=new_avg,
            )
            db.add(position_obj)
    else:
        proceeds = -cost
        realized_delta = proceeds - qty * (pos.avg_price if pos else 0.0)
        new_shares = held - qty
        if new_shares <= EPS:
            if pos:
                await db.delete(pos)
            position_obj = None
        else:
            pos.shares = new_shares

    locked_user.balance -= cost
    locked_user.realized_pnl += realized_delta
    market.volume += abs(cost)

    trade = Trade(
        user_id=user.id, market_id=market_id, outcome_id=outcome_id,
        side=side, shares=qty, price=per_share, cost=abs(cost),
    )
    db.add(trade)
    new_prices = lmsr_prices([o.shares_outstanding for o in outcomes], b)
    db.add(PricePoint(market_id=market_id, prices=new_prices))

    await db.commit()

    return {
        "trade": {
            "id": trade.id, "user_id": user.id, "user_name": locked_user.name,
            "market_id": market_id, "outcome_id": outcome_id,
            "outcome_label": outcomes[idx].label, "side": side, "shares": qty,
            "price": per_share, "cost": abs(cost), "created_at": trade.created_at,
        },
        "prices": prices_payload(outcomes, b),
        "balance": locked_user.balance,
        "realized_pnl": locked_user.realized_pnl,
        "market_volume": market.volume,
        "position": (
            {"outcome_id": outcome_id, "shares": position_obj.shares,
             "avg_price": position_obj.avg_price} if position_obj else None
        ),
    }


async def resolve_market(db: AsyncSession, market_id: str, winning_outcome_id: str) -> dict:
    market = (await db.execute(
        select(Market).where(Market.id == market_id).with_for_update()
    )).scalar_one_or_none()
    if market is None:
        raise HTTPException(404, "Market not found")
    if market.status == "resolved":
        raise HTTPException(400, "Market already resolved")

    outcomes = (await db.execute(
        select(Outcome).where(Outcome.market_id == market_id).order_by(Outcome.position)
    )).scalars().all()
    if winning_outcome_id not in {o.id for o in outcomes}:
        raise HTTPException(400, "Winning outcome does not belong to this market")

    positions = (await db.execute(
        select(Position).where(Position.market_id == market_id)
    )).scalars().all()

    payouts: dict[str, list[float]] = {}  # user_id -> [balance_delta, realized_delta]
    for p in positions:
        payout = p.shares if p.outcome_id == winning_outcome_id else 0.0
        d = payouts.setdefault(p.user_id, [0.0, 0.0])
        d[0] += payout
        d[1] += payout - p.shares * p.avg_price

    for uid in sorted(payouts):  # consistent order -> no resolve/resolve deadlock
        u = (await db.execute(
            select(User).where(User.id == uid).with_for_update()
        )).scalar_one()
        u.balance += payouts[uid][0]
        u.realized_pnl += payouts[uid][1]

    await db.execute(delete(Position).where(Position.market_id == market_id))
    market.status = "resolved"
    market.resolved_outcome_id = winning_outcome_id
    final = [1.0 if o.id == winning_outcome_id else 0.0 for o in outcomes]
    db.add(PricePoint(market_id=market_id, prices=final))
    await db.commit()

    return {
        "market_id": market_id, "status": "resolved",
        "resolved_outcome_id": winning_outcome_id,
        "prices": [
            {"outcome_id": o.id, "label": o.label, "price": final[i]}
            for i, o in enumerate(outcomes)
        ],
    }