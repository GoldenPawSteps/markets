# app/models.py
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    String, Float, Integer, ForeignKey, DateTime, Boolean, Text, func, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar: Mapped[str] = mapped_column(String(4), default="??")
    color: Mapped[str] = mapped_column(String(9), default="#4f46e5")
    balance: Mapped[float] = mapped_column(Float, default=1000.0)
    start_balance: Mapped[float] = mapped_column(Float, default=1000.0)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_bot: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    positions = relationship("Position", back_populates="user", cascade="all, delete-orphan")
    trades = relationship("Trade", back_populates="user")


class Market(Base):
    __tablename__ = "markets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    question: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(64), default="Other", index=True)
    type: Mapped[str] = mapped_column(String(16), default="binary")   # binary | categorical
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open | resolved
    liquidity_param: Mapped[float] = mapped_column(Float, default=150.0)
    volume: Mapped[float] = mapped_column(Float, default=0.0)
    close_date: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolution_criteria: Mapped[str] = mapped_column(Text, default="")
    resolved_outcome_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    outcomes = relationship(
        "Outcome", back_populates="market", cascade="all, delete-orphan",
        order_by="Outcome.position",
    )
    creator = relationship("User")


class Outcome(Base):
    __tablename__ = "outcomes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    market_id: Mapped[str] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(128))
    position: Mapped[int] = mapped_column(Integer, default=0)
    shares_outstanding: Mapped[float] = mapped_column(Float, default=0.0)

    market = relationship("Market", back_populates="outcomes")


class Position(Base):
    __tablename__ = "positions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    market_id: Mapped[str] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"), index=True)
    outcome_id: Mapped[str] = mapped_column(ForeignKey("outcomes.id", ondelete="CASCADE"), index=True)
    shares: Mapped[float] = mapped_column(Float, default=0.0)
    avg_price: Mapped[float] = mapped_column(Float, default=0.0)

    user = relationship("User", back_populates="positions")
    __table_args__ = (UniqueConstraint("user_id", "outcome_id", name="uq_user_outcome"),)


class Trade(Base):
    __tablename__ = "trades"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    market_id: Mapped[str] = mapped_column(ForeignKey("markets.id"), index=True)
    outcome_id: Mapped[str] = mapped_column(ForeignKey("outcomes.id"), index=True)
    side: Mapped[str] = mapped_column(String(4))             # buy | sell
    shares: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)              # average fill price / share
    cost: Mapped[float] = mapped_column(Float)               # absolute credits moved
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    user = relationship("User", back_populates="trades")


class PricePoint(Base):
    __tablename__ = "price_points"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    market_id: Mapped[str] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    prices: Mapped[list] = mapped_column(JSONB)             # [p0, p1, ...] aligned to outcome order


class Comment(Base):
    __tablename__ = "comments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    market_id: Mapped[str] = mapped_column(ForeignKey("markets.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")