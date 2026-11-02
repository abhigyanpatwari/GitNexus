"""The two providers' accounting equations, encoded literally.

Adding OpenAI's cache fields to its input_tokens double-counts, because they are
subsets of it. Subtracting Anthropic's under-counts, because they are additional
categories. A single generic struct cannot be right for both, so these tests
pin each equation rather than the field names.
"""

from __future__ import annotations

import pytest

from workflow_bench.provider_usage import (
    ANTHROPIC,
    OPENAI_RESPONSES,
    UsageSemanticsError,
    normalize_usage,
)


def _openai(input_tokens: int, cached: int | None = None, cache_write: int | None = None) -> dict:
    details: dict[str, int] = {}
    if cached is not None:
        details["cached_tokens"] = cached
    if cache_write is not None:
        details["cache_write_tokens"] = cache_write
    return {
        "input_tokens": input_tokens,
        "input_tokens_details": details,
        "output_tokens": 300,
        "output_tokens_details": {"reasoning_tokens": 250},
    }


def test_openai_uncached_request_is_all_ordinary_input() -> None:
    usage = normalize_usage(OPENAI_RESPONSES, _openai(1000, cached=0, cache_write=0))
    assert usage.ordinary_input_tokens == 1000
    assert usage.total_input_tokens == 1000
    assert (usage.cache_read_input_tokens, usage.cache_write_input_tokens) == (0, 0)


def test_openai_cache_creation_keeps_the_parts_summing_to_input_tokens() -> None:
    """The subsets must reconstruct the whole, never exceed it."""

    usage = normalize_usage(OPENAI_RESPONSES, _openai(1000, cached=0, cache_write=400))
    assert usage.ordinary_input_tokens == 600
    assert (
        usage.ordinary_input_tokens
        + usage.cache_read_input_tokens
        + usage.cache_write_input_tokens
        == usage.total_input_tokens
    )


def test_openai_cache_hit_plus_new_write_uses_the_documented_subtraction() -> None:
    usage = normalize_usage(OPENAI_RESPONSES, _openai(10_000, cached=7_000, cache_write=1_000))
    assert usage.ordinary_input_tokens == 2_000
    assert usage.total_input_tokens == 10_000, "input_tokens is the whole, not a component"


def test_openai_reasoning_tokens_decompose_output_rather_than_adding_to_it() -> None:
    usage = normalize_usage(OPENAI_RESPONSES, _openai(100, cached=0, cache_write=0))
    assert usage.output_tokens == 300
    assert usage.reasoning_output_tokens == 250
    assert usage.reasoning_output_tokens <= usage.output_tokens


def test_anthropic_uncached_total_is_just_input_tokens() -> None:
    usage = normalize_usage(
        ANTHROPIC,
        {"input_tokens": 1000, "cache_creation_input_tokens": 0,
         "cache_read_input_tokens": 0, "output_tokens": 200},
    )
    assert usage.total_input_tokens == 1000
    assert usage.ordinary_input_tokens == 1000


def test_anthropic_cached_total_adds_the_cache_categories() -> None:
    """The opposite equation to OpenAI's, on deliberately identical numbers."""

    usage = normalize_usage(
        ANTHROPIC,
        {"input_tokens": 2_000, "cache_creation_input_tokens": 1_000,
         "cache_read_input_tokens": 7_000, "output_tokens": 200},
    )
    assert usage.total_input_tokens == 10_000
    assert usage.ordinary_input_tokens == 2_000


def test_the_same_numbers_mean_different_totals_on_the_two_providers() -> None:
    """The whole reason a shared struct is unsafe, in one assertion."""

    openai = normalize_usage(OPENAI_RESPONSES, _openai(10_000, cached=7_000, cache_write=1_000))
    anthropic = normalize_usage(
        ANTHROPIC,
        {"input_tokens": 10_000, "cache_creation_input_tokens": 1_000,
         "cache_read_input_tokens": 7_000, "output_tokens": 300},
    )
    assert openai.total_input_tokens == 10_000
    assert anthropic.total_input_tokens == 18_000
    assert openai.ordinary_input_tokens == 2_000
    assert anthropic.ordinary_input_tokens == 10_000


def test_missing_native_cache_fields_are_unknown_and_never_zero() -> None:
    """A zero we invented is indistinguishable from a zero the provider reported."""

    usage = normalize_usage(OPENAI_RESPONSES, {"input_tokens": 1000, "output_tokens": 10})
    assert usage.cache_read_input_tokens is None
    assert usage.cache_write_input_tokens is None
    assert usage.ordinary_input_tokens is None, "cannot subtract what was never reported"
    assert usage.total_input_tokens == 1000
    assert not usage.complete
    assert "cache_read_input_tokens" in usage.unknown_fields


def test_an_absent_usage_object_is_entirely_unknown() -> None:
    usage = normalize_usage(ANTHROPIC, None)
    assert not usage.complete
    assert usage.total_input_tokens is None


def test_an_unknown_provider_is_refused_rather_than_guessed() -> None:
    with pytest.raises(UsageSemanticsError, match="refusing to guess"):
        normalize_usage("some-new-provider", {"input_tokens": 1})


def test_cache_subsets_larger_than_the_whole_are_rejected() -> None:
    """Nonsense arithmetic must surface, not silently produce a negative."""

    with pytest.raises(UsageSemanticsError, match="exceed input_tokens"):
        normalize_usage(OPENAI_RESPONSES, _openai(100, cached=90, cache_write=50))
