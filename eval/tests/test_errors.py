from utils.errors import sanitize_exception


def _raise_value_error():
    raise ValueError("boom")


def test_sanitize_exception_without_debug(monkeypatch):
    monkeypatch.delenv("GITNEXUS_EVAL_DEBUG", raising=False)
    try:
        _raise_value_error()
    except Exception as exc:  # noqa: BLE001
        data = sanitize_exception(exc, include_debug=False)

    assert data["error_type"] == "ValueError"
    assert data["error_message"] == "boom"
    assert "error_detail_debug" not in data


def test_sanitize_exception_with_debug(monkeypatch):
    monkeypatch.setenv("GITNEXUS_EVAL_DEBUG", "1")
    try:
        _raise_value_error()
    except Exception as exc:  # noqa: BLE001
        data = sanitize_exception(exc)

    assert data["error_type"] == "ValueError"
    assert "error_detail_debug" in data
    assert "ValueError" in data["error_detail_debug"]
