"""Per-request usage as the provider reported it, plus a derived cross-provider view.

The benchmark has been reading token counts out of Claude Code's session output,
which is Anthropic-shaped whatever actually served the request. That works until
the upstream is OpenAI, because the two providers do not merely name their fields
differently - they mean opposite things by them:

    Anthropic:  total_input = input_tokens
                            + cache_creation_input_tokens
                            + cache_read_input_tokens
                (input_tokens is only the UNCACHED remainder; cache fields ADD)

    OpenAI:     total_input = input_tokens
                ordinary    = input_tokens - cached_tokens - cache_write_tokens
                (input_tokens is the WHOLE; cache fields are SUBSETS)

Adding OpenAI's three together double-counts; subtracting Anthropic's
under-counts. So the native object is authoritative and is stored verbatim, and
the normalized view is derived from it per provider.

The second rule is that a field nobody reported is UNKNOWN, not zero. A stored
``cache_read = 0`` previously could mean either "the provider said zero" or "our
adapter never looked", and those two must never be written identically again:
the first says caching is not working, the second says we cannot tell.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

SCHEMA_VERSION = 1

# Read by the in-proxy callback and forwarded by the gateway that launches it.
# Defined here because this module is pure stdlib: model_gateway can import the
# name without importing litellm, which only the callback needs.
#
# Both are SWEEP-scoped, and that is a constraint rather than an oversight.
# attach_openai_gateway wraps the whole sweep (runner.py), so one proxy serves
# every cell and its environment is fixed for that proxy's lifetime - while
# cells run concurrently under --workers and interleave requests through it. An
# environment variable therefore cannot carry a per-cell identity: it would
# record one constant against every event. Attributing a request to a cell
# needs an identifier that travels WITH the request; see the session fields the
# callback records for the intended hook.
USAGE_LOG_ENV_VAR = "GITNEXUS_BENCH_PROVIDER_USAGE"
SWEEP_ID_ENV_VAR = "GITNEXUS_BENCH_SWEEP_ID"
USAGE_ENV_VARS = (USAGE_LOG_ENV_VAR, SWEEP_ID_ENV_VAR)

ANTHROPIC = "anthropic"
OPENAI_RESPONSES = "openai-responses"


class UsageSemanticsError(ValueError):
    """The native usage object does not satisfy its own provider's arithmetic."""


@dataclass(frozen=True)
class NormalizedUsage:
    """Cross-provider view. ``None`` means the provider did not report it.

    Deliberately not defaulted to 0: see the module docstring. Every consumer
    that sums these has to decide what to do about unknown, and making it None
    forces that decision to be explicit instead of silently counting zero.
    """

    ordinary_input_tokens: int | None
    cache_read_input_tokens: int | None
    cache_write_input_tokens: int | None
    total_input_tokens: int | None
    output_tokens: int | None
    reasoning_output_tokens: int | None

    @property
    def complete(self) -> bool:
        return all(
            value is not None
            for value in (
                self.ordinary_input_tokens,
                self.cache_read_input_tokens,
                self.cache_write_input_tokens,
                self.total_input_tokens,
                self.output_tokens,
            )
        )

    @property
    def unknown_fields(self) -> tuple[str, ...]:
        return tuple(
            name for name, value in sorted(vars(self).items()) if value is None
        )


def _int_or_none(source: Mapping[str, Any] | None, key: str) -> int | None:
    """Absent, null, or non-numeric all read as unknown rather than zero."""

    if not isinstance(source, Mapping):
        return None
    value = source.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _normalize_openai_responses(usage: Mapping[str, Any]) -> NormalizedUsage:
    """input_tokens is the WHOLE; cached and cache-write are subsets of it."""

    total = _int_or_none(usage, "input_tokens")
    details = usage.get("input_tokens_details")
    cache_read = _int_or_none(details, "cached_tokens")
    cache_write = _int_or_none(details, "cache_write_tokens")
    output_details = usage.get("output_tokens_details")

    ordinary: int | None = None
    if total is not None and cache_read is not None and cache_write is not None:
        ordinary = total - cache_read - cache_write
        if ordinary < 0:
            raise UsageSemanticsError(
                f"OpenAI cached ({cache_read}) + cache_write ({cache_write}) "
                f"exceed input_tokens ({total})"
            )
    return NormalizedUsage(
        ordinary_input_tokens=ordinary,
        cache_read_input_tokens=cache_read,
        cache_write_input_tokens=cache_write,
        total_input_tokens=total,
        output_tokens=_int_or_none(usage, "output_tokens"),
        # A decomposition of output_tokens, not an addition to it.
        reasoning_output_tokens=_int_or_none(output_details, "reasoning_tokens"),
    )


def _normalize_anthropic(usage: Mapping[str, Any]) -> NormalizedUsage:
    """input_tokens is the uncached REMAINDER; the cache fields add to it."""

    ordinary = _int_or_none(usage, "input_tokens")
    cache_read = _int_or_none(usage, "cache_read_input_tokens")
    cache_write = _int_or_none(usage, "cache_creation_input_tokens")

    total: int | None = None
    if ordinary is not None and cache_read is not None and cache_write is not None:
        total = ordinary + cache_read + cache_write
    return NormalizedUsage(
        ordinary_input_tokens=ordinary,
        cache_read_input_tokens=cache_read,
        cache_write_input_tokens=cache_write,
        total_input_tokens=total,
        output_tokens=_int_or_none(usage, "output_tokens"),
        reasoning_output_tokens=None,
    )


def canonical_provider(label: str | None, call_type: str | None) -> str | None:
    """Map LiteLLM's provider label onto an adapter key, or None if unsure.

    LiteLLM reports ``custom_llm_provider`` as "openai" for both Chat
    Completions and Responses, and those two report usage differently, so the
    label alone cannot pick an adapter. The call type is what distinguishes
    them. Returning None when it does not is deliberate: normalize_usage
    refuses an unknown provider rather than guessing token semantics, which is
    the whole point of keeping the native object authoritative.
    """

    if label == "openai" and call_type and "responses" in call_type:
        return OPENAI_RESPONSES
    if label in _ADAPTERS:
        return label
    return None


_ADAPTERS = {
    ANTHROPIC: _normalize_anthropic,
    OPENAI_RESPONSES: _normalize_openai_responses,
}


def normalize_usage(provider: str, native_usage: Mapping[str, Any] | None) -> NormalizedUsage:
    """Derive the cross-provider view. Never mutates or replaces the native object."""

    adapter = _ADAPTERS.get(provider)
    if adapter is None:
        raise UsageSemanticsError(
            f"no usage adapter for provider {provider!r}; refusing to guess its token semantics"
        )
    if not isinstance(native_usage, Mapping):
        return NormalizedUsage(None, None, None, None, None, None)
    return adapter(native_usage)
