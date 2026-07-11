"""Unit tests for the pure aggregation/report helpers of workflow_bench."""

from workflow_bench.runner import aggregate, render_report, savings


def record(**overrides):
    base = {
        "input_tokens": 1000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 5000,
        "output_tokens": 400,
        "cost_usd": 0.5,
        "duration_s": 60.0,
        "num_turns": 10,
        "resolved": True,
    }
    base.update(overrides)
    return base


def test_aggregate_takes_medians_and_counts_resolved():
    records = [
        record(input_tokens=1000, resolved=True),
        record(input_tokens=3000, resolved=False),
        record(input_tokens=2000, resolved=True),
    ]
    agg = aggregate(records)
    assert agg == {
        "input_tokens": 2000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 5000,
        "output_tokens": 400,
        "cost_usd": 0.5,
        "duration_s": 60.0,
        "num_turns": 10,
        "resolved": 2,
        "runs": 3,
    }


def test_savings_is_positive_when_workflow_is_cheaper():
    baseline = aggregate([record(input_tokens=2000, output_tokens=800, cost_usd=1.0)])
    workflow = aggregate([record(input_tokens=1000, output_tokens=400, cost_usd=0.4)])
    s = savings(baseline, workflow)
    assert s["input_tokens"] == 50.0
    assert s["output_tokens"] == 50.0
    assert s["cost_usd"] == 60.0


def test_savings_handles_zero_baseline_without_dividing():
    baseline = aggregate([record(cost_usd=0.0)])
    workflow = aggregate([record(cost_usd=0.0)])
    assert savings(baseline, workflow)["cost_usd"] == 0.0


def test_render_report_emits_arm_rows_and_savings_row():
    results = {
        "demo-task": {
            "baseline": aggregate([record(input_tokens=2000)]),
            "workflow": aggregate([record(input_tokens=1000)]),
        }
    }
    report = render_report(results)
    assert "| demo-task | baseline | 1/1 | 2000 |" in report
    assert "| demo-task | workflow | 1/1 | 1000 |" in report
    assert "| demo-task | **savings %** | — | 50.0 |" in report
    assert "results.jsonl" in report
