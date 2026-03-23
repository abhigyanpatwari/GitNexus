from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from analysis.analyze_results import parse_run_id
from environments.gitnexus_docker import GitNexusDockerEnvironment
from tool_registry import TOOL_SPECS
from utils.errors import sanitize_exception


KNOWN_MODES = [
    "native_augment",
    "native",
    "baseline",
    "mcp",
    "augment",
    "full",
]


def _model_strategy():
    base_chars = st.characters(
        blacklist_categories=("Cs",),
        blacklist_characters={" ", "\n", "\t"},
    )
    text = st.text(alphabet=base_chars, min_size=1)
    return text.filter(lambda s: not any(s.endswith(f"_{m}") for m in KNOWN_MODES))


@given(_model_strategy(), st.sampled_from(KNOWN_MODES))
def test_parse_run_id_round_trip(model: str, mode: str) -> None:
    run_id = f"{model}_{mode}"
    parsed_model, parsed_mode = parse_run_id(run_id)
    assert parsed_model == model
    assert parsed_mode == mode


@given(st.text())
def test_sanitize_exception_respects_debug_flag(message: str) -> None:
    exc = ValueError(message)
    data = sanitize_exception(exc, include_debug=False)
    assert data["error_type"] == "ValueError"
    assert data["error_message"] == (message or "ValueError")
    assert "error_detail_debug" not in data

    data_debug = sanitize_exception(exc, include_debug=True)
    assert data_debug["error_type"] == "ValueError"
    assert "error_detail_debug" in data_debug
    assert data_debug["error_detail_debug"]


@given(st.sampled_from(list(TOOL_SPECS.values())), st.integers(min_value=1, max_value=99999))
def test_render_tool_script_contains_expected_paths(spec, port: int) -> None:
    script = GitNexusDockerEnvironment._render_tool_script(spec, str(port))

    assert spec.fallback.strip() in script
    if spec.endpoint:
        assert spec.endpoint in script
        assert f"${{GITNEXUS_EVAL_PORT:-{port}}}" in script
        assert "curl" in script
    else:
        assert "curl" not in script
