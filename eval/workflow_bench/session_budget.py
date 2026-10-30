"""Validate opt-in CLI-reported session budgets, not provider billing caps."""

from __future__ import annotations

import math


def session_budget(value: float | None) -> float | None:
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("--max-budget-usd must be finite and greater than zero")
    return float(value)
