import unittest
from unittest.mock import AsyncMock, patch

from app.config import Settings
from app.main import app, health, initialize_database


class TestDatabaseStartup(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_database_returns_false_when_db_is_unavailable(self):
        with patch("app.main.wait_for_db", AsyncMock(side_effect=RuntimeError("db down"))), patch("app.main.logger") as mock_logger:
            result = await initialize_database()

        self.assertFalse(result)
        mock_logger.warning.assert_called_once()

    async def test_health_returns_starting_status_when_db_is_not_ready(self):
        app.state.db_ready = False
        response = await health()

        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["database"], "starting")
        self.assertFalse(response["db_ready"])

    def test_settings_normalize_render_postgres_url_to_asyncpg(self):
        settings = Settings(database_url="postgres://user:pass@host:5432/db")

        self.assertEqual(settings.database_url, "postgresql+asyncpg://user:pass@host:5432/db")
