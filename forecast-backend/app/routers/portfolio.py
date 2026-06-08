# app/routers/trades.py
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from .. import models, schemas, crud
from ..database import get_db
from ..security import get_current_user
from ..ws import manager

router = APIRouter(prefix="/trades", tags=["trades"])


@router.post("")
async def create_trade(
    body: schemas.TradeCreate,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await crud.execute_trade(
        db, user, body.market_id, body.outcome_id, body.side, body.shares
    )
    payload = {
        "type": "market_update", "market_id": body.market_id,
        "prices": result["prices"], "volume": result["market_volume"],
        "trade": result["trade"],
    }
    await manager.publish(f"market:{body.market_id}", payload)
    await manager.publish("feed", payload)
    return result