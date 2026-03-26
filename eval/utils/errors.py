from __future__ import annotations

import os
import traceback
from typing import Any, Callable

from constants import DEBUG_ENV_VAR


def is_debug_enabled() -> bool:
    """Return True when debug output (full tracebacks) should be emitted."""
    return os.getenv(DEBUG_ENV_VAR, "").strip().lower() in {"1", "true", "yes", "on"}


def sanitize_exception(exc: BaseException, *, include_debug: bool | None = None) -> dict[str, str]:
    """
    Produce a log-safe, JSON-friendly view of an exception.

    - Always returns error_type and error_message.
    - Only includes error_detail_debug (full traceback) when debug is enabled.
    """
    debug = is_debug_enabled() if include_debug is None else include_debug

    error_type = type(exc).__name__
    message = str(exc) or error_type

    data: dict[str, str] = {
        "error_type": error_type,
        "error_message": message,
    }

    if debug:
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        if tb:
            data["error_detail_debug"] = tb

    return data


def log_safe_exception(
    logger: Any,
    prefix: str,
    exc: BaseException,
    *,
    include_debug: bool | None = None,
    level: str = "error",
) -> dict[str, str]:
    """
    Log an exception without leaking stack traces unless debug is enabled.

    Returns the sanitized dict so callers can persist it.
    """
    data = sanitize_exception(exc, include_debug=include_debug)
    debug = "error_detail_debug" in data

    log_fn: Callable[..., None] = getattr(logger, level, logger.error)
    message = f"{prefix}: {data['error_type']}: {data['error_message']}"
    log_kwargs = {"exc_info": True} if debug else {}
    log_fn(message, **log_kwargs)
    return data
