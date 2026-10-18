"""PR cost measurements retain the historical task pins and quality floor."""

import json
from copy import deepcopy
from datetime import UTC, datetime

import pytest
import yaml

from workflow_bench import pr_evaluation
from workflow_bench.release_report import build_report, validate_report

NOW = datetime.now(UTC)
OLD = "a" * 40
NEW = "b" * 40
HARNESS = "c" * 40
REPO = "owner/repo"


@pytest.fixture
def evidence():
    metadata = {
        "runtime_sha": OLD,
        "harness_sha": OLD,
        "task_set_digest": "d" * 64,
        "model": "gpt-5.6-sol",
        "effort": "xhigh",
        "runs": 3,
        "tasks": {name: {"sha": "e" * 40, "oracle_digest": "f" * 64} for name in ("one", "two")},
    }
    rows = [
        {
            "task": task,
            "run": run,
            "arm": arm,
            "model": metadata["model"],
            "effort": "xhigh",
            "task_base_sha": "e" * 40,
            "oracle_digest": "f" * 64,
            "sandbox_backend": "bwrap",
            "sandbox_dependency_content_digest": "9" * 64,
            "ok": True,
            "resolved": True,
            "authored_tests_passed": True,
            "oracle_passed": True,
            "error_kind": None,
            "transcript_missing": False,
            "cost_usd": 1.0,
            "duration_s": 60.0,
        }
        for task in metadata["tasks"]
        for run in range(3)
        for arm in ("baseline_nomcp", "baseline")
    ]
    previous = build_report(rows, metadata, now=NOW)
    candidate = [
        {**row, "cost_usd": 0.8, "internal_path": "/private/transcript"} for row in rows if row["arm"] == "baseline"
    ]
    return previous, candidate, {**metadata, "runtime_sha": NEW, "harness_sha": HARNESS}


def compare(evidence):
    previous, rows, metadata = evidence
    return pr_evaluation.compare_candidate(
        rows, metadata, previous, candidate_sha=NEW, pr=3621, baseline_run=39039452570, now=NOW
    )


def test_comparison_measures_only_new_mcp_cells_and_preserves_historical_cost(evidence):
    before = deepcopy(evidence)
    report = compare(evidence)
    assert report["complete"] and report["quality_preserved"] and report["improved"]
    assert report["previous"]["total_cost_usd"] == 6
    assert report["candidate"]["total_cost_usd"] == pytest.approx(4.8)
    assert report["cost_reduction_pct"] == pytest.approx(20)
    assert report["candidate"]["solved"] == report["previous"]["solved"] == 6
    assert len(report["per_run"]) == 6
    assert all(row["arm"] == "baseline" and "internal_path" not in row for row in report["per_run"])
    assert evidence == before
    assert "not release approval" in pr_evaluation.render_markdown(report)
    with pytest.raises(ValueError, match="unsupported"):
        validate_report(report, runtime_sha=NEW, task_set_digest=evidence[0]["task_set_digest"], now=NOW)


@pytest.mark.parametrize(
    "change",
    [
        lambda rows: rows.pop(),
        lambda rows: rows.append(dict(rows[0])),
        lambda rows: rows[0].update(cost_usd=None),
        lambda rows: rows[0].update(cost_usd=float("nan")),
        lambda rows: rows[0].update(cost_usd=10**1000),
        lambda rows: rows[0].update(duration_s=-1),
        lambda rows: rows[0].update(model="other-model"),
        lambda rows: rows[0].update(task_base_sha="0" * 40),
        lambda rows: rows[0].update(oracle_digest="0" * 64),
        lambda rows: rows[0].update(sandbox_dependency_content_digest="0" * 64),
        lambda rows: rows[0].update(sandbox_backend="host-unsafe"),
        lambda rows: rows[0].update(error_kind="session-error", ok=False),
        lambda rows: rows[0].update(transcript_missing=True),
        lambda rows: rows[0].update(arm="baseline_nomcp"),
        lambda rows: rows[0].update(resolved="true"),
        lambda rows: rows[0].update(oracle_passed=False),
        lambda rows: rows.append(None),
    ],
)
def test_incomplete_or_mismatched_cells_cannot_claim_savings(evidence, change):
    change(evidence[1])
    report = compare(evidence)
    assert not report["complete"] and not report["improved"]
    assert report["problems"]
    assert report["cost_reduction_pct"] is None
    json.dumps(report, allow_nan=False)


def test_lower_cost_with_a_per_task_solve_regression_is_not_an_improvement(evidence):
    evidence[1][0].update(resolved=False, oracle_passed=False, error_kind="oracle-failed")
    report = compare(evidence)
    assert report["complete"] and not report["quality_preserved"] and not report["improved"]
    assert report["tasks"]["one"]["solve_delta"] == -1


@pytest.mark.parametrize(
    "field,value",
    [
        ("runtime_sha", OLD),
        ("model", "other"),
        ("effort", "high"),
        ("runs", 1),
        ("task_set_digest", "0" * 64),
        ("tasks", {}),
    ],
)
def test_candidate_metadata_must_match_the_requested_revision_and_previous_protocol(evidence, field, value):
    evidence[2][field] = value
    assert not compare(evidence)["complete"]


def test_cost_regression_remains_a_valid_measurement(evidence):
    for row in evidence[1]:
        row["cost_usd"] = 1.1
    report = compare(evidence)
    assert report["complete"] and report["quality_preserved"] and not report["improved"]
    assert report["cost_reduction_pct"] == pytest.approx(-10)


def pr_payload():
    return {
        "state": "open",
        "head": {"sha": NEW},
        "base": {"ref": "main", "repo": {"full_name": REPO}},
        "labels": [{"name": pr_evaluation.COST_LABEL}],
    }


def test_pr_resolution_is_bound_to_the_explicit_reviewed_sha(monkeypatch):
    monkeypatch.setattr(pr_evaluation, "_gh_json", lambda endpoint: pr_payload())
    assert pr_evaluation.resolve_pr(REPO, 3621, NEW) == NEW


@pytest.mark.parametrize(
    "mutation",
    [
        lambda pr: pr.update(state="closed"),
        lambda pr: pr["head"].update(sha=OLD),
        lambda pr: pr["base"].update(ref="feature"),
        lambda pr: pr["base"]["repo"].update(full_name="other/repo"),
        lambda pr: pr.update(labels=[]),
        lambda pr: pr.pop("labels"),
    ],
)
def test_moved_or_wrong_target_pr_is_rejected_before_paid_work(monkeypatch, mutation):
    payload = pr_payload()
    mutation(payload)
    monkeypatch.setattr(pr_evaluation, "_gh_json", lambda endpoint: payload)
    with pytest.raises(ValueError):
        pr_evaluation.resolve_pr(REPO, 3621, NEW)


@pytest.fixture
def label_request(monkeypatch):
    event = {
        "repository": {"full_name": REPO},
        "action": "labeled",
        "label": {"name": pr_evaluation.COST_LABEL},
        "sender": {"login": "maintainer"},
        "number": 3621,
        "pull_request": pr_payload(),
    }
    run = {
        "id": 90,
        "conclusion": "success",
        "head_branch": "main",
        "event": "workflow_dispatch",
        "head_repository": {"full_name": REPO},
        "head_sha": OLD,
    }
    payloads = {
        f"repos/{REPO}/collaborators/maintainer/permission": {"permission": "write", "role_name": "maintain"},
        f"repos/{REPO}/pulls/3621": pr_payload(),
        f"repos/{REPO}/actions/workflows/release-evaluation.yml/runs?branch=main&status=success&per_page=100": {
            "workflow_runs": [run],
        },
        f"repos/{REPO}/actions/runs/90/artifacts?per_page=100": {
            "total_count": 1,
            "artifacts": [{"name": f"release-agent-evaluation-{OLD}", "expired": False}],
        },
    }
    calls = []
    monkeypatch.setattr(pr_evaluation, "_gh_json", payloads.__getitem__)
    monkeypatch.setattr(pr_evaluation, "_gh", lambda args: calls.append(args))
    return event, payloads, calls


def test_label_dispatch_pins_head_main_baseline_and_model(label_request):
    event, _, calls = label_request
    assert pr_evaluation.dispatch_labeled_pr(REPO, event) == 90
    assert not calls  # Requests emit outputs for a reusable job, never manual dispatch.


@pytest.mark.parametrize("permission", ["write", "read", "triage", "none", "custom-role", ""])
def test_label_requires_repository_write_permission(label_request, permission):
    event, payloads, calls = label_request
    payloads[f"repos/{REPO}/collaborators/maintainer/permission"]["role_name"] = permission
    with pytest.raises(ValueError, match="repository maintainers or administrators"):
        pr_evaluation.dispatch_labeled_pr(REPO, event)
    assert not calls


@pytest.mark.parametrize("role,permission", [("maintain", "write"), ("admin", "admin")])
def test_maintain_and_admin_roles_may_request_comparison(label_request, role, permission):
    event, payloads, calls = label_request
    payloads[f"repos/{REPO}/collaborators/maintainer/permission"].update(role_name=role, permission=permission)
    assert pr_evaluation.dispatch_labeled_pr(REPO, event) == 90
    assert not calls


def test_missing_role_does_not_grant_maintainer_authority(label_request):
    event, payloads, calls = label_request
    payloads[f"repos/{REPO}/collaborators/maintainer/permission"].pop("role_name")
    with pytest.raises(ValueError, match="maintainers"):
        pr_evaluation.dispatch_labeled_pr(REPO, event)
    assert not calls


def test_label_cli_emits_validated_reusable_workflow_outputs(label_request, monkeypatch, tmp_path, capsys):
    event, _, calls = label_request
    source = tmp_path / "event.json"
    source.write_text(json.dumps(event))
    monkeypatch.setattr("sys.argv", ["pr_evaluation", "dispatch-label", "--repo", REPO, "--event", str(source)])
    pr_evaluation.main()
    assert capsys.readouterr().out == f"pr=3621\nsha={NEW}\ncomparison_run_id=90\n"
    assert not calls


@pytest.mark.parametrize(
    "mutation",
    [
        lambda event: event.update(action="synchronize"),
        lambda event: event["label"].update(name="run-ci"),
        lambda event: event["repository"].update(full_name="other/repo"),
        lambda event: event["sender"].update(login="name/permission"),
    ],
)
def test_unrelated_events_never_dispatch(label_request, mutation):
    event, _, calls = label_request
    mutation(event)
    with pytest.raises(ValueError):
        pr_evaluation.dispatch_labeled_pr(REPO, event)
    assert not calls


@pytest.mark.parametrize(
    "mutation",
    [
        lambda pr: pr.update(labels=[]),
        lambda pr: pr["head"].update(sha=OLD),
    ],
)
def test_label_or_head_changed_during_discovery_never_dispatches(label_request, monkeypatch, mutation):
    event, payloads, calls = label_request
    reads = 0

    def api(endpoint):
        nonlocal reads
        if endpoint == f"repos/{REPO}/pulls/3621":
            reads += 1
            if reads == 2:
                mutation(payloads[endpoint])
        return payloads[endpoint]

    monkeypatch.setattr(pr_evaluation, "_gh_json", api)
    with pytest.raises(ValueError):
        pr_evaluation.dispatch_labeled_pr(REPO, event)
    assert reads == 2 and not calls


@pytest.mark.parametrize(
    "artifact",
    [
        {"name": f"pr-cost-comparison-{NEW}", "expired": False},
        {"name": f"release-agent-evaluation-{OLD}", "expired": True},
        None,
    ],
)
def test_label_skips_preview_expired_and_probe_runs(label_request, artifact):
    event, payloads, calls = label_request
    runs = next(value["workflow_runs"] for value in payloads.values() if "workflow_runs" in value)
    runs.insert(0, {**runs[0], "id": 91})
    payloads[f"repos/{REPO}/actions/runs/91/artifacts?per_page=100"] = {
        "total_count": int(artifact is not None),
        "artifacts": [] if artifact is None else [artifact],
    }
    assert pr_evaluation.dispatch_labeled_pr(REPO, event) == 90
    assert not calls


def test_label_without_a_full_baseline_does_not_dispatch(label_request):
    event, payloads, calls = label_request
    payloads[f"repos/{REPO}/actions/runs/90/artifacts?per_page=100"]["artifacts"] = []
    with pytest.raises(ValueError, match="no full successful"):
        pr_evaluation.dispatch_labeled_pr(REPO, event)
    assert not calls


def test_previous_measurement_accepts_only_preview_orchestration_changes(monkeypatch):
    monkeypatch.setattr(
        pr_evaluation,
        "_gh_json",
        lambda endpoint: {"status": "ahead", "files": [{"filename": "eval/workflow_bench/pr_evaluation.py"}]},
    )
    pr_evaluation.require_comparable_harness(REPO, OLD, HARNESS)


@pytest.fixture
def workflow_protocol_pair():
    old = {
        "jobs": {
            "evaluate": {
                "runs-on": "self-hosted",
                "environment": "gitnexus-evolution",
                "timeout-minutes": 1260,
                "env": {"MODEL": "gpt-5.6-sol", "EFFORT": "xhigh"},
                "steps": [
                    {"uses": "setup-node@abc", "with": {"node-version": "22"}},
                    {"name": "Prepare", "run": "uv run prepare --runs 3\n"},
                    {
                        "name": "Run",
                        "timeout-minutes": 1140,
                        "run": (
                            "set -euo pipefail\nfor runtime in stable candidate; do\n"
                            "  uv run --locked --extra dev python -m workflow_bench.runner "
                            "--arms baseline_nomcp baseline --runs 3 --include-expensive "
                            "--workers 3 --timeout 3600\ndone\n"
                        ),
                    },
                ],
            }
        },
    }
    new = deepcopy(old)
    job = new["jobs"]["evaluate"]
    job["env"].update(INPUT_PR="3621", INPUT_PR_SHA=NEW, COMPARISON_RUN_ID="42")
    job["steps"][-1]["run"] = (
        "set -euo pipefail\narms=(baseline_nomcp baseline)\n"
        'if [[ -n "$INPUT_PR" ]]; then arms=(baseline); fi\n'
        "for runtime in stable candidate; do\n"
        '  if [[ -n "$INPUT_PR" && "$runtime" == stable ]]; then continue; fi\n'
        "  uv run --locked --extra dev python -m workflow_bench.runner "
        '--arms "${arms[@]}" --runs 3 --include-expensive '
        "--workers 3 --timeout 3600\ndone\n"
    )
    return old, new


def test_changed_workflow_requires_matching_measurement_protocol(monkeypatch, workflow_protocol_pair):
    old, new = workflow_protocol_pair
    monkeypatch.setattr(
        pr_evaluation,
        "_gh_json",
        lambda endpoint: {
            "status": "ahead",
            "files": [{"filename": pr_evaluation.EVALUATION_WORKFLOW}],
        },
    )
    calls = []

    def api(args):
        calls.append(args)
        return yaml.safe_dump(old if f"ref={OLD}" in args[1] else new)

    monkeypatch.setattr(pr_evaluation, "_gh", api)
    pr_evaluation.require_comparable_harness(REPO, OLD, HARNESS)
    assert len(calls) == 2 and all("Accept: application/vnd.github.raw+json" in call for call in calls)
    new["jobs"]["evaluate"]["steps"][-1]["run"] += "echo changed measurement\n"
    with pytest.raises(ValueError, match="measurement protocol changed"):
        pr_evaluation.require_comparable_harness(REPO, OLD, HARNESS)


@pytest.mark.parametrize(
    "before,after",
    [
        ("--workers 3", "--workers 1"),
        ("--timeout 3600", "--timeout 60"),
        ("--runs 3", "--runs 2"),
        (" --include-expensive", ""),
        ("arms=(baseline);", "arms=(baseline_nomcp);"),
    ],
)
def test_workflow_protocol_rejects_changed_paid_settings(workflow_protocol_pair, before, after):
    old, new = workflow_protocol_pair
    step = new["jobs"]["evaluate"]["steps"][-1]
    step["run"] = step["run"].replace(before, after)
    assert pr_evaluation.measurement_protocol(yaml.safe_dump(old)) != pr_evaluation.measurement_protocol(
        yaml.safe_dump(new)
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda job: job["steps"][0]["with"].update({"node-version": "24"}),
        lambda job: job["steps"][-1].update({"timeout-minutes": 1200}),
        lambda job: job["env"].update(MODEL="another-model"),
        lambda job: job["env"].update(ANTHROPIC_BASE_URL="another-provider"),
        lambda job: job["steps"][1].update(run="uv run prepare --runs 2\n"),
    ],
)
def test_workflow_protocol_rejects_changed_setup_or_environment(workflow_protocol_pair, mutation):
    old, new = workflow_protocol_pair
    mutation(new["jobs"]["evaluate"])
    assert pr_evaluation.measurement_protocol(yaml.safe_dump(old)) != pr_evaluation.measurement_protocol(
        yaml.safe_dump(new)
    )


def test_workflow_protocol_rejects_extra_paid_invocations(workflow_protocol_pair):
    _, new = workflow_protocol_pair
    new["jobs"]["evaluate"]["steps"].append({"run": "python -m workflow_bench.runner"})
    with pytest.raises(ValueError, match="one paid"):
        pr_evaluation.measurement_protocol(yaml.safe_dump(new))


@pytest.mark.parametrize(
    "comparison",
    [
        {"status": "diverged", "files": []},
        {"status": "ahead"},
        {"status": "ahead", "files": [{"filename": "eval/workflow_bench/runner.py"}]},
        {"status": "ahead", "files": [{"filename": ".github/claude-canary-runtime/package-lock.json"}]},
        {"status": "ahead", "files": [{"filename": "other.py", "previous_filename": "eval/workflow_bench/runner.py"}]},
        {"status": "ahead", "files": [{"filename": "other.py"}] * 300},
    ],
)
def test_changed_measurement_inputs_or_unknown_history_reject_previous_evidence(monkeypatch, comparison):
    monkeypatch.setattr(pr_evaluation, "_gh_json", lambda endpoint: comparison)
    with pytest.raises(ValueError):
        pr_evaluation.require_comparable_harness(REPO, OLD, HARNESS)


@pytest.fixture
def github(evidence, monkeypatch):
    from workflow_bench import release_report

    previous = evidence[0]
    payload = {
        "run": {
            "id": 42,
            "path": ".github/workflows/release-evaluation.yml",
            "conclusion": "success",
            "head_branch": "main",
            "head_sha": OLD,
            "event": "workflow_dispatch",
            "head_repository": {"full_name": REPO},
        },
        "artifacts": {"total_count": 1, "artifacts": [{"name": f"release-agent-evaluation-{OLD}", "expired": False}]},
        "report": previous,
    }

    def api(endpoint):
        if "/artifacts?" in endpoint:
            return payload["artifacts"]
        if "/compare/" in endpoint:
            return {"status": "ahead", "files": []}
        return payload["run"]

    def download(arguments):
        from pathlib import Path

        assert arguments[:4] == ["run", "download", "42", "--repo"]
        assert arguments[4] == REPO
        (Path(arguments[-1]) / "agent-evaluation.json").write_text(json.dumps(payload["report"]))
        return ""

    monkeypatch.setattr(pr_evaluation, "_gh_json", api)
    monkeypatch.setattr(pr_evaluation, "_gh", download)
    monkeypatch.setattr(release_report, "suite_binding", lambda: ([], previous["task_set_digest"], previous["tasks"]))
    return payload


def test_baseline_download_authenticates_run_artifact_and_recomputes_report(github):
    assert pr_evaluation.fetch_baseline(REPO, 42, HARNESS, "gpt-5.6-sol", "xhigh") == github["report"]


@pytest.mark.parametrize(
    "mutation",
    [
        lambda g: g["run"].update(conclusion="failure"),
        lambda g: g["run"].update(head_branch="feature"),
        lambda g: g["run"].update(path=".github/workflows/other.yml"),
        lambda g: g["run"].update(id=99),
        lambda g: g["run"]["head_repository"].update(full_name="fork/repo"),
        lambda g: g["artifacts"].update(total_count=101),
        lambda g: g["artifacts"]["artifacts"][0].update(expired=True),
        lambda g: g["artifacts"]["artifacts"][0].update(name=f"pr-cost-comparison-{OLD}"),
        lambda g: g["report"].update(runtime_sha=NEW),
        lambda g: g["report"].update(harness_sha=HARNESS),
        lambda g: g["report"].update(complete=False),
        lambda g: g["report"]["arms"]["baseline"].update(mean_cost_usd=0),
    ],
)
def test_untrusted_or_tampered_historical_evidence_is_rejected_before_paid_work(github, mutation):
    mutation(github)
    with pytest.raises(ValueError):
        pr_evaluation.fetch_baseline(REPO, 42, HARNESS, "gpt-5.6-sol", "xhigh")


def test_cli_writes_sanitized_candidate_report_and_marks_missing_measurements_incomplete(
    evidence, tmp_path, monkeypatch
):
    previous, rows, metadata = evidence
    baseline, results, meta, out = (tmp_path / name for name in ("previous.json", "rows.jsonl", "metadata.json", "out"))
    baseline.write_text(json.dumps(previous))
    meta.write_text(json.dumps(metadata))
    results.write_text("\n".join(json.dumps(row) for row in rows))
    monkeypatch.setattr(
        "sys.argv",
        [
            "pr-evaluation",
            "summarize",
            "--results",
            str(results),
            "--metadata",
            str(meta),
            "--baseline",
            str(baseline),
            "--out",
            str(out),
            "--sha",
            NEW,
            "--pr",
            "3621",
            "--run-id",
            "42",
        ],
    )
    pr_evaluation.main()
    text = (out / "pr-cost-comparison.json").read_text()
    assert json.loads(text)["improved"]
    assert "/private/transcript" not in text
    results.unlink()
    with pytest.raises(SystemExit) as exc:
        pr_evaluation.main()
    assert exc.value.code == 1
    assert not json.loads((out / "pr-cost-comparison.json").read_text())["complete"]
    assert "Incomplete evidence" in (out / "pr-cost-comparison.md").read_text()


def bindings(previous):
    return [
        {
            "id": task,
            "resolved_sha": pin["sha"],
            "oracle_digest": pin["oracle_digest"],
            "sandbox_dependency_content_digest": "9" * 64,
        }
        for task, pin in previous["tasks"].items()
    ]


def test_dependency_preflight_accepts_identical_prepared_task_bytes(evidence):
    previous = evidence[0]
    pr_evaluation.check_dependency_bindings(bindings(previous), previous)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda bs: bs.pop(),
        lambda bs: bs.append(dict(bs[0])),
        lambda bs: bs[0].update(resolved_sha=NEW),
        lambda bs: bs[0].update(oracle_digest="0" * 64),
        lambda bs: bs[0].update(sandbox_dependency_content_digest="0" * 64),
    ],
)
def test_dependency_preflight_rejects_incompatible_bytes_before_paid_sessions(evidence, mutation):
    previous = evidence[0]
    prepared = bindings(previous)
    mutation(prepared)
    with pytest.raises(ValueError):
        pr_evaluation.check_dependency_bindings(prepared, previous)
