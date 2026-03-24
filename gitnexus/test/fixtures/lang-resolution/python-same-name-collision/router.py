import metrics as app_metrics

def get_metrics():
    """Router handler — same name as metrics.get_metrics().
    The call below must resolve to metrics.py:get_metrics, not self."""
    data = app_metrics.get_metrics()
    return data

def health():
    """Different name — no collision."""
    app_metrics.emit("health_check")
