# app/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/forecast"
    jwt_secret: str = "change-me-please-use-a-long-random-string"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7
    admin_only_create: bool = False
    enable_bot_simulator: bool = False
    starting_balance: float = 1000.0
    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def __init__(self, **values):
        super().__init__(**values)
        self.database_url = self._normalize_database_url(self.database_url)

    @staticmethod
    def _normalize_database_url(url: str) -> str:
        if not url:
            return url

        parsed = make_url(url)
        if str(parsed.drivername) in {"postgres", "postgresql"}:
            return parsed.set(drivername="postgresql+asyncpg").render_as_string(hide_password=False)

        return url

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()