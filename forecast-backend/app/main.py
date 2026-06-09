# app/main.py
from __future__ import annotations
import asyncio
import json
import logging
import random
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from . import crud
from .config import settings
from .database import engine, AsyncSessionLocal
from .models import Base, Market, Outcome, User, utcnow
from .seed import seed_if_empty
from .ws import manager
from .routers import auth, markets, trades, portfolio

logger = logging.getLogger(__name__)


async def bot_loop():
    """Stands in for an external order flow: random bot buys push live prices."""
    await asyncio.sleep(3)
    rng = random.Random()
    while True:
        try:
            await asyncio.sleep(2.6)
            async with AsyncSessionLocal() as db:
                now = utcnow()
                open_markets = (await db.execute(
                    select(Market).where(Market.status == "open", Market.close_date > now)
                )).scalars().all()
                if not open_markets:
                    continue
                m = rng.choice(open_markets)
                outcomes = (await db.execute(
                    select(Outcome).where(Outcome.market_id == m.id).order_by(Outcome.position)
                )).scalars().all()
                bots = (await db.execute(select(User).where(User.is_bot.is_(True)))).scalars().all()
                if not outcomes or not bots:
                    continue
                bot = rng.choice(bots)
                oc = rng.choice(outcomes)
                qty = float(1 + rng.randint(0, 4))
                try:
                    result = await crud.execute_trade(db, bot, m.id, oc.id, "buy", qty)
                except Exception:
                    continue
                payload = {
                    "type": "market_update", "market_id": m.id,
                    "prices": result["prices"], "volume": result["market_volume"],
                    "trade": result["trade"],
                }
                await manager.publish(f"market:{m.id}", payload)
                await manager.publish("feed", payload)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(1)


async def wait_for_db(retries: int = 15, delay: float = 1.0):
    last_error = None
    for attempt in range(retries):
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
                return
        except Exception as exc:
            last_error = exc
            await asyncio.sleep(delay)
    raise RuntimeError("Could not connect to the database after multiple attempts") from last_error


async def initialize_database() -> bool:
    try:
        await wait_for_db()
    except Exception as exc:
        logger.warning("Database not available during startup; continuing without initialization: %s", exc)
        return False

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with AsyncSessionLocal() as db:
            await seed_if_empty(db)
        return True
    except Exception as exc:
        logger.warning("Database initialization failed during startup: %s", exc)
        return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db_ready = await initialize_database()
    task = asyncio.create_task(bot_loop()) if settings.enable_bot_simulator else None
    yield
    if task:
        task.cancel()
    await engine.dispose()


app = FastAPI(title="ForeCast API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(markets.router)
app.include_router(trades.router)
app.include_router(portfolio.router)


@app.get("/")
async def root():
    return {"name": "ForeCast API", "status": "ok", "docs": "/docs"}


@app.get("/health")
async def health():
    if not getattr(app.state, "db_ready", False):
        return {"status": "ok", "database": "starting", "db_ready": False}

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        return {"status": "ok", "database": "degraded", "db_ready": False}

    return {"status": "ok", "database": "connected", "db_ready": True}


@app.get("/config")
async def public_config():
    return {
        "admin_only_create": settings.admin_only_create,
        "starting_balance": settings.starting_balance,
        "bot_simulator": settings.enable_bot_simulator,
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """
    Protocol (client -> server JSON):
      {"action": "subscribe",   "topic": "market:<id>"}  # or "feed"
      {"action": "unsubscribe", "topic": "market:<id>"}
      {"action": "ping"}
    Server pushes: market_update | market_resolved | market_created | comment | pong
    """
    await manager.connect(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            action, topic = msg.get("action"), msg.get("topic")
            if action == "subscribe" and topic:
                manager.subscribe(ws, topic)
            elif action == "unsubscribe" and topic:
                manager.unsubscribe(ws, topic)
            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)