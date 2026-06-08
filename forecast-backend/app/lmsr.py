"""
Logarithmic Market Scoring Rule (Hanson). Identical math to the React client.

Given shares-outstanding q = (q_1..q_n) and liquidity b > 0:

  Cost:   C(q) = b * ln( sum_i exp(q_i / b) )
  Price:  p_i  = exp(q_i/b) / sum_j exp(q_j/b)      (sum_i p_i == 1)
  Trade:  cost = C(q + Δ·e_i) - C(q)                (buy Δ>0; sell Δ<0 -> you receive -cost)

Average fill price = |cost| / |Δ|; slippage = |avg_fill - marginal price p_i|.
Worst-case maker subsidy is bounded by b·ln(n). C is computed with the
log-sum-exp trick for numerical stability.
"""
from __future__ import annotations
import math
from typing import List, Optional


def lmsr_cost(shares: List[float], b: float) -> float:
    m = max(shares)
    s = sum(math.exp((q - m) / b) for q in shares)
    return m + b * math.log(s)


def lmsr_prices(shares: List[float], b: float) -> List[float]:
    m = max(shares)
    ex = [math.exp((q - m) / b) for q in shares]
    s = sum(ex)
    return [e / s for e in ex]


def cost_to_trade(shares: List[float], b: float, idx: int, delta: float) -> float:
    after = list(shares)
    after[idx] += delta
    return lmsr_cost(after, b) - lmsr_cost(shares, b)


def max_affordable(shares: List[float], b: float, idx: int, budget: float) -> int:
    """Largest whole-share buy of outcome `idx` affordable for `budget`."""
    if budget <= 0:
        return 0
    hi = 1.0
    while cost_to_trade(shares, b, idx, hi) < budget and hi < 5e6:
        hi *= 2
    lo = 0.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if cost_to_trade(shares, b, idx, mid) <= budget:
            lo = mid
        else:
            hi = mid
    return math.floor(lo)


def quote_trade(shares: List[float], b: float, idx: int, side: str, qty: float,
                balance: float, held: float) -> dict:
    """Pure preview used by the /quote endpoint (mirrors the UI trade preview)."""
    prices = lmsr_prices(shares, b)
    cur = prices[idx]
    if qty <= 0:
        return {"shares": 0, "side": side, "cur_price": cur, "error": "Enter a quantity"}
    delta = qty if side == "buy" else -qty
    cost = cost_to_trade(shares, b, idx, delta)
    after = list(shares)
    after[idx] += delta
    new_price = lmsr_prices(after, b)[idx]
    abscost = abs(cost)
    error: Optional[str] = None
    if side == "buy" and cost > balance + 1e-9:
        error = "Insufficient balance"
    if side == "sell" and qty > held + 1e-9:
        error = "Not enough shares"
    return {
        "shares": qty,
        "side": side,
        "cur_price": cur,
        "new_price": new_price,
        "avg_price": abscost / qty,
        "cost": abscost,
        "proceeds": (-cost) if side == "sell" else 0.0,
        "max_payout": qty if side == "buy" else None,
        "max_profit": (qty - abscost) if side == "buy" else None,
        "error": error,
    }