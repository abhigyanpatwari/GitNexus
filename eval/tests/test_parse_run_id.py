import pytest

analysis_module = pytest.importorskip("analysis.analyze_results")
parse_run_id = analysis_module.parse_run_id


def test_parse_run_id_native_augment():
    model, mode = parse_run_id("claude-sonnet_native_augment")
    assert model == "claude-sonnet"
    assert mode == "native_augment"


def test_parse_run_id_hyphenated_model():
    model, mode = parse_run_id("glm-4.7_native")
    assert model == "glm-4.7"
    assert mode == "native"


def test_parse_run_id_unknown():
    assert parse_run_id("custom_model") == ("custom_model", "unknown")
