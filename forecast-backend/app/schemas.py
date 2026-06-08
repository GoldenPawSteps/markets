# app/schemas.py
from __future__ import annotations
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field, ConfigDict


class RegisterBody(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    email: Optional[str] = None
    password: str = Field(min_length=6, max_length=128)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    avatar: str
    color: str
    balance: float
    start_balance: float
    realized_pnl: float
    is_admin: bool
    is_bot: bool
    created_at: datetime


class MarketCreate(BaseModel):
    question: str = Field(min_length=8)
    description: str = ""
    category: str = "Other"
    type: Literal["binary", "categorical"] = "binary"
    outcomes: list[str] = []
    close_date: datetime
    resolution_criteria: str = ""
    liquidity_param: float = Field(default=150.0, gt=0)


class TradeCreate(BaseModel):
    market_id: str
    outcome_id: str
    side: Literal["buy", "sell"]
    shares: float = Field(gt=0)


class ResolveBody(BaseModel):
    winning_outcome_id: str


class CommentCreate(BaseModel):
    text: str = Field(min_length=1, max_length=1000)