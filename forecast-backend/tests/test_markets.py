import math
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app import crud
from app.routers import markets
from app.schemas import MarketCreate


class TestMarketCreation(unittest.IsolatedAsyncioTestCase):
    async def test_create_market_deducts_collateral(self):
        user = SimpleNamespace(id="u1", balance=1000.0, realized_pnl=0.0, is_admin=False)
        now = datetime.now(timezone.utc)
        mock_market = SimpleNamespace(
            id="m1",
            question="Will this happen?",
            description="",
            category="Other",
            type="binary",
            status="open",
            liquidity_param=150.0,
            close_date=now + timedelta(days=1),
            created_at=now,
            volume=0.0,
            created_by="u1",
            resolved_outcome_id=None,
            outcomes=[
                SimpleNamespace(id="o1", label="Yes", position=0, shares_outstanding=0.0),
                SimpleNamespace(id="o2", label="No", position=1, shares_outstanding=0.0),
            ],
        )

        db = MagicMock()
        db.add = MagicMock()
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            SimpleNamespace(scalar_one=lambda: user),
            SimpleNamespace(scalar_one_or_none=lambda: mock_market),
        ])

        body = MarketCreate(
            question="Will this happen?",
            description="Test market",
            category="Other",
            type="binary",
            outcomes=[],
            close_date=now + timedelta(days=1),
            resolution_criteria="",
            liquidity_param=150.0,
        )

        with patch.object(markets.manager, "publish", AsyncMock()):
            result = await markets.create_market(body, user=user, db=db)

        expected_collateral = body.liquidity_param * math.log(2)
        self.assertAlmostEqual(user.balance, 1000.0 - expected_collateral)
        self.assertAlmostEqual(result["balance"], user.balance)
        self.assertTrue(db.flush.await_count == 1)
        self.assertTrue(db.commit.await_count == 1)

    async def test_create_market_raises_if_insufficient_balance(self):
        user = SimpleNamespace(id="u1", balance=1.0, realized_pnl=0.0, is_admin=False)
        now = datetime.now(timezone.utc)

        db = MagicMock()
        db.add = MagicMock()
        db.flush = AsyncMock()
        db.commit = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            SimpleNamespace(scalar_one=lambda: user),
        ])

        body = MarketCreate(
            question="Will this happen?",
            description="Test market",
            category="Other",
            type="binary",
            outcomes=[],
            close_date=now + timedelta(days=1),
            resolution_criteria="",
            liquidity_param=150.0,
        )

        with self.assertRaises(Exception) as cm:
            await markets.create_market(body, user=user, db=db)

        self.assertIn("Insufficient balance", str(cm.exception))
        self.assertEqual(db.flush.await_count, 0)
        self.assertEqual(db.commit.await_count, 0)

    async def test_resolve_market_refunds_creator(self):
        now = datetime.now(timezone.utc)
        market = SimpleNamespace(
            id="m1",
            status="open",
            liquidity_param=150.0,
            created_by="u1",
        )
        outcomes = [
            SimpleNamespace(id="o1", label="Yes", position=0, shares_outstanding=0.0),
            SimpleNamespace(id="o2", label="No", position=1, shares_outstanding=0.0),
        ]
        creator = SimpleNamespace(id="u1", balance=850.0, realized_pnl=0.0)

        db = MagicMock()
        db.add = MagicMock()
        db.commit = AsyncMock()
        db.execute = AsyncMock(side_effect=[
            SimpleNamespace(scalar_one_or_none=lambda: market),
            SimpleNamespace(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=outcomes)))),
            SimpleNamespace(scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))),
            SimpleNamespace(scalar_one=lambda: creator),
            MagicMock(),
        ])

        result = await crud.resolve_market(db, market.id, "o1")

        expected_collateral = market.liquidity_param * math.log(2)
        self.assertAlmostEqual(creator.balance, 850.0 + expected_collateral)
        self.assertAlmostEqual(creator.realized_pnl, 0.0)
        self.assertEqual(result["resolved_outcome_id"], "o1")
        self.assertAlmostEqual(result["maker_refund"], expected_collateral)
