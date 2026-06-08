# app/seed.py
from __future__ import annotations
import math
import random
from datetime import timedelta
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession
from . import crud
from .models import User, Market, Outcome, PricePoint, Comment, utcnow
from .config import settings
from .security import hash_password
from .lmsr import lmsr_prices


def _sample_index(target, r):
    c = 0.0
    for i, t in enumerate(target):
        c += t
        if r <= c:
            return i
    return len(target) - 1


def _interp_history(rng, n_out, end_prices, start_ts, end_ts, n=36):
    uniform = [1.0 / n_out] * n_out
    pts = []
    span = (end_ts - start_ts).total_seconds()
    for k in range(n + 1):
        f = k / n
        ease = f * f * (3 - 2 * f)
        ts = start_ts + timedelta(seconds=span * f)
        row = []
        for i in range(n_out):
            v = uniform[i] + (end_prices[i] - uniform[i]) * ease
            v = max(0.001, v + (rng.random() - 0.5) * 0.02 * (1 - ease))
            row.append(v)
        s = sum(row)
        pts.append((ts, [x / s for x in row]))
    return pts


async def seed_if_empty(db: AsyncSession) -> None:
    count = (await db.execute(select(func.count(Market.id)))).scalar() or 0
    if count > 0:
        return

    rng = random.Random(20260608)
    now = utcnow()

    demo = User(
        name="You", email="demo@forecast.app", hashed_password=hash_password("demo1234"),
        avatar="YO", color="#4f46e5", balance=settings.starting_balance,
        start_balance=settings.starting_balance, is_admin=True, is_bot=False,
        created_at=now - timedelta(days=45),
    )
    db.add(demo)

    bot_defs = [
        ("QuantWhale", "QW", "#0891b2", 2200), ("MarketMaven", "MM", "#7c3aed", 1500),
        ("HedgeHog", "HH", "#d97706", 900), ("OddsOracle", "OO", "#16a34a", 1800),
        ("PaperHands", "PH", "#e11d48", 650), ("DiamondMind", "DM", "#4f46e5", 1300),
        ("NoiseTrader", "NT", "#0d9488", 1000),
    ]
    bots = {}
    for name, av, col, bal in bot_defs:
        u = User(name=name, avatar=av, color=col, balance=float(bal), start_balance=float(bal),
                 is_bot=True, created_at=now - timedelta(days=30 + rng.randint(0, 60)))
        db.add(u)
        bots[name] = u
    await db.flush()

    def cid(name):  # creator id helper
        return bots[name].id

    # spec: question, desc, type, category, b, labels, close_days(+future/-past),
    #       resolution, creator, created_days_ago, target, kind, win_label
    specs = [
        ("Will it rain in New York City tomorrow?",
         "Forecasts measurable precipitation in Central Park during the calendar day.",
         "binary", "Weather", 140, ["Yes", "No"], 1,
         "Resolves YES if NWS reports >= 0.01in precipitation in Central Park.",
         "OddsOracle", 14, [0.36, 0.64], "open", None),
        ("Will Bitcoin close above $100,000 this year?",
         "Resolves on the daily settlement price from a major spot index.",
         "binary", "Crypto", 170, ["Yes", "No"], 120,
         "Resolves YES if BTC/USD closes >= $100,000 on any day before close.",
         "QuantWhale", 40, [0.58, 0.42], "open", None),
        ("Will the Fed cut rates at the next meeting?",
         "Based on the official FOMC statement target range decision.",
         "binary", "Economics", 150, ["Yes", "No"], 22,
         "Resolves YES if the upper bound of the target range is lowered.",
         "MarketMaven", 18, [0.70, 0.30], "open", None),
        ("Who will win the next World Cup?",
         "A categorical market across leading national teams.",
         "categorical", "Sports", 260, ["Brazil", "Argentina", "France", "Spain", "England", "Field"], 200,
         "Resolves to the team that lifts the trophy. Field = any other team.",
         "OddsOracle", 30, [0.22, 0.19, 0.17, 0.14, 0.12, 0.16], "open", None),
        ("Will Starship reach orbit again this year?",
         "Tracks whether an orbital-class flight achieves orbital velocity.",
         "binary", "Tech", 150, ["Yes", "No"], 90,
         "Resolves YES upon a verified orbital-velocity flight before close.",
         "DiamondMind", 25, [0.63, 0.37], "open", None),
        ("Which lab tops the next major model benchmark?",
         "Resolves on the next widely-cited frontier benchmark leaderboard.",
         "categorical", "Tech", 220, ["OpenAI", "Anthropic", "Google", "Meta", "Other"], 60,
         "Resolves to the org holding the #1 score at close.",
         "QuantWhale", 20, [0.34, 0.27, 0.24, 0.07, 0.08], "open", None),
        ("Will unemployment exceed 4.5% next report?",
         "Based on the headline U-3 rate in the next jobs report.",
         "binary", "Economics", 150, ["Yes", "No"], 25,
         "Resolves YES if the reported U-3 rate is strictly above 4.5%.",
         "HedgeHog", 12, [0.33, 0.67], "open", None),
        ("Will this be the hottest year on record?",
         "Global mean surface temperature vs. the instrumental record.",
         "binary", "Climate", 180, ["Yes", "No"], 250,
         "Resolves YES if a major dataset ranks the year #1 on record.",
         "OddsOracle", 35, [0.61, 0.39], "open", None),
        ("Did the spring event reveal a foldable phone?",
         "A market that has reached its close date and awaits resolution.",
         "binary", "Tech", 150, ["Yes", "No"], -3,
         "Resolves YES if a foldable device was officially announced.",
         "MarketMaven", 20, [0.42, 0.58], "closed", None),
        ("Did the home team win Game 7?",
         "A resolved example market showing payouts.",
         "binary", "Sports", 130, ["Yes", "No"], -9,
         "Resolves YES if the home team won the deciding game.",
         "DiamondMind", 22, [0.55, 0.45], "resolved", "Yes"),
    ]

    market_specs = []  # (market_id, spec_tuple)
    for sp in specs:
        (q, desc, mtype, cat, b, labels, close_days, res, creator, created_days, target, kind, win) = sp
        m = Market(
            question=q, description=desc, category=cat, type=mtype, liquidity_param=float(b),
            resolution_criteria=res, created_by=cid(creator),
            created_at=now - timedelta(days=created_days),
            close_date=now + timedelta(days=400),  # temporary; trading is open during seeding
            status="open",
        )
        db.add(m)
        await db.flush()
        for i, label in enumerate(labels):
            db.add(Outcome(market_id=m.id, label=label, position=i, shares_outstanding=0.0))
        await db.flush()
        market_specs.append((m.id, sp))
    await db.commit()

    bot_list = list(bots.values())

    # Drive real bot trades to build shares / volume / positions / trades
    for mid, sp in market_specs:
        target = sp[10]
        outcomes = (await db.execute(
            select(Outcome).where(Outcome.market_id == mid).order_by(Outcome.position)
        )).scalars().all()
        ids = [o.id for o in outcomes]
        for _ in range(12):
            bot = rng.choice(bot_list)
            oi = _sample_index(target, rng.random()) if rng.random() < 0.72 else rng.randrange(len(ids))
            qty = float(1 + rng.randint(0, 7))
            try:
                await crud.execute_trade(db, bot, mid, ids[oi], "buy", qty)
            except Exception:
                pass

    # Demo user starting positions
    demo_positions = [
        ("Will the Fed cut rates at the next meeting?", "Yes", 80.0),
        ("Will Bitcoin close above $100,000 this year?", "Yes", 60.0),
        ("Who will win the next World Cup?", "Brazil", 50.0),
        ("Will Starship reach orbit again this year?", "No", 50.0),
    ]
    for mid, sp in market_specs:
        for q_text, label, qty in demo_positions:
            if sp[0] == q_text:
                oc = (await db.execute(
                    select(Outcome).where(Outcome.market_id == mid, Outcome.label == label)
                )).scalar_one_or_none()
                if oc:
                    try:
                        await crud.execute_trade(db, demo, mid, oc.id, "buy", qty)
                    except Exception:
                        pass

    # Set real close dates, backfill clean price history, then resolve where needed
    for mid, sp in market_specs:
        close_days, kind, win = sp[6], sp[11], sp[12]
        m = await db.get(Market, mid)
        m.close_date = now + timedelta(days=close_days)
        await db.commit()

        outcomes = (await db.execute(
            select(Outcome).where(Outcome.market_id == mid).order_by(Outcome.position)
        )).scalars().all()
        cur = lmsr_prices([o.shares_outstanding for o in outcomes], m.liquidity_param)
        end_ts = now if m.close_date > now else m.close_date
        await db.execute(delete(PricePoint).where(PricePoint.market_id == mid))
        for ts, row in _interp_history(rng, len(outcomes), cur, m.created_at, end_ts, 36):
            db.add(PricePoint(market_id=mid, ts=ts, prices=row))
        await db.commit()

        if kind == "resolved" and win:
            woc = next((o for o in outcomes if o.label == win), None)
            if woc:
                await crud.resolve_market(db, mid, woc.id)

    # A few seed comments
    async def add_comment(question, bot_name, text, hours_ago):
        m = (await db.execute(select(Market).where(Market.question == question))).scalar_one_or_none()
        if not m:
            return
        uid = demo.id if bot_name == "You" else bots[bot_name].id
        db.add(Comment(market_id=m.id, user_id=uid, text=text, created_at=now - timedelta(hours=hours_ago)))

    await add_comment("Will Bitcoin close above $100,000 this year?", "QuantWhale", "ETF flows look strong - leaning yes here.", 6)
    await add_comment("Will Bitcoin close above $100,000 this year?", "PaperHands", "Sold half my position, too volatile for me.", 4)
    await add_comment("Will the Fed cut rates at the next meeting?", "MarketMaven", "CPI print basically locks in the cut, no?", 3)
    await add_comment("Who will win the next World Cup?", "OddsOracle", "Field is underpriced relative to history.", 9)
    await add_comment("Will it rain in New York City tomorrow?", "You", "Radar looks clear tonight - fading the yes side.", 1)
    await db.commit()