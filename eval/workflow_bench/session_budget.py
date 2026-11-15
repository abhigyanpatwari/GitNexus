"""Validate opt-in CLI-reported session budgets, not provider billing caps."""

from __future__ import annotations

import math


def session_budget(value: float | None) -> float | None:
    if value is None:
        return None
    message = "--max-budget-usd must be finite and greater than zero"
    if type(value) not in (int, float):
        raise ValueError(message)
    try:
        budget = float(value)
    except OverflowError as exc:
        raise ValueError(message) from exc
    if not math.isfinite(budget) or budget <= 0:
        raise ValueError(message)
    return budget
