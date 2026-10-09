"""Release comparisons must retain negative outcomes and reject incomplete evidence."""

from datetime import UTC, datetime, timedelta
import json
import subprocess

import pytest
import yaml

from workflow_bench import release_report
from workflow_bench.release_report import build_report, pinned_task_sha, render_markdown, validate_report


SHA = "a" * 40
DIGEST = "b" * 64
NOW = datetime(2026, 10, 6, tzinfo=UTC)


def metadata():
    return {
        "runtime_sha": SHA,
        "harness_sha": "c" * 40,
        "task_set_digest": DIGEST,
        "model": "gpt-6.1-sol",
        "effort": "medium",
        "runs": 3,
        "tasks": {"task-one": {"sha": "d" * 40, "oracle_digest": "e" * 64}},
    }


def rows():
    return [
        {
            "task": "task-one",
            "run": run,
            "arm": arm,
            "model": "gpt-6.1-sol",
            "effort": "medium",
            "task_base_sha": "d" * 40,
            "oracle_digest": "e" * 64,
            "sandbox_backend": "bwrap",
            "sandbox_dependency_content_digest": "9" * 64,
            "ok": True,
            "resolved": arm == "baseline_nomcp" or run != 1,
            "authored_tests_passed": True,
            "oracle_passed": arm == "baseline_nomcp" or run != 1,
            "error_kind": "oracle-failed" if arm == "baseline" and run == 1 else None,
            "transcript_missing": False,
            "cost_usd": 1.0 if arm == "baseline_nomcp" else 1.25,
            "duration_s": 60.0 if arm == "baseline_nomcp" else 75.0,
            "internal_path": "/home/private/instructions.md",
        }
        for run in range(3)
        for arm in ("baseline_nomcp", "baseline")
    ]


def test_report_keeps_failed_solutions_and_compares_against_no_gitnexus():
    report = build_report(rows(), metadata(), now=NOW)
    assert report["complete"] is True
    assert report["arms"]["baseline_nomcp"]["solved"] == 3
    assert report["arms"]["baseline"]["solved"] == 2
    assert report["paired"]["solve_delta"] == -1
    assert report["paired"]["mean_cost_change_pct"] == 25.0
    assert report["paired"]["mean_wall_change_pct"] == 25.0
    assert "internal_path" not in report["per_run"][0]
    assert report["per_run"][0]["sandbox_dependency_content_digest"] == "9" * 64
    assert "baseline_nomcp" in render_markdown(report)
    assert "n=3" in render_markdown(report)
    validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda rs: rs.pop(),
        lambda rs: rs.append(dict(rs[0])),
        lambda rs: rs[0].update(cost_usd=None),
        lambda rs: rs[0].update(cost_usd=float("nan")),
        lambda rs: rs[0].update(cost_usd=[float("nan")]),
        lambda rs: rs[0].update(duration_s={"wall": float("inf")}),
        lambda rs: rs[0].update(duration_s=-1),
        lambda rs: rs[0].update(task_base_sha="f" * 40),
        lambda rs: rs[0].update(oracle_digest="f" * 64),
        lambda rs: rs[0].update(model="different-model"),
        lambda rs: rs[0].update(sandbox_backend="host-unsafe"),
        lambda rs: rs[0].update(error_kind="session-error", ok=False),
        lambda rs: rs[0].update(transcript_missing=True),
        lambda rs: rs[0].update(resolved="true"),
        lambda rs: rs[0].update(oracle_passed=False),
    ],
)
def test_partial_or_untrustworthy_measurements_cannot_pass_release_gate(mutation):
    measured = rows()
    mutation(measured)
    report = build_report(measured, metadata(), now=NOW)
    assert report["complete"] is False
    assert report["problems"]
    json.dumps(report, allow_nan=False)
    with pytest.raises(ValueError, match="incomplete"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


@pytest.mark.parametrize(
    "change",
    [
        {"runtime_sha": "f" * 40},
        {"task_set_digest": "f" * 64},
        {"generated_at": (NOW - timedelta(days=8)).isoformat()},
        {"generated_at": (NOW + timedelta(seconds=1)).isoformat()},
        {"runs": 2},
    ],
)
def test_evidence_is_bound_to_revision_task_set_repetitions_and_age(change):
    report = build_report(rows(), metadata(), now=NOW)
    report.update(change)
    with pytest.raises(ValueError):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


def test_gate_recomputes_measurements_instead_of_trusting_totals():
    report = build_report(rows(), metadata(), now=NOW)
    report["arms"]["baseline"]["solved"] = 3
    with pytest.raises(ValueError, match="summary"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


def test_torn_result_file_publishes_incomplete_evidence(tmp_path, monkeypatch):
    from workflow_bench.release_report import main

    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps(rows()[0]) + '\n{"unfinished":')
    meta = tmp_path / "metadata.json"
    meta.write_text(json.dumps(metadata()))
    out = tmp_path / "public"
    monkeypatch.setattr(
        "sys.argv",
        ["release-report", "summarize", "--results", str(results), "--metadata", str(meta), "--out", str(out)],
    )
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 1
    report = json.loads((out / "agent-evaluation.json").read_text())
    assert report["complete"] is False
    assert "invalid measurement" in report["problems"][0]
    assert "Incomplete evidence" in (out / "agent-evaluation.md").read_text()


def test_validate_report_binds_the_trusted_task_pins():
    report = build_report(rows(), metadata(), now=NOW)
    validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, task_pins=metadata()["tasks"], now=NOW)
    other = {"task-one": {"sha": "d" * 40, "oracle_digest": "f" * 64}}
    with pytest.raises(ValueError, match="pins"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, task_pins=other, now=NOW)


def commit_repo(path, content):
    path.mkdir()
    (path / "marker.txt").write_text(content)
    for arguments in (
        ["init", "-q"],
        ["add", "."],
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", content],
    ):
        subprocess.run(["git", "-C", str(path), *arguments], check=True, capture_output=True)
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()


@pytest.fixture
def prepare_suite(tmp_path, monkeypatch):
    task_sha = commit_repo(tmp_path / "tasks-base", "pinned task commit")
    runtimes = {name: commit_repo(tmp_path / name, name) for name in ("stable", "candidate")}
    tasks = [
        {"id": task_id, "repo": "~/GitNexus", "ref": task_sha, "prompt": "p", "verify": "true"}
        for task_id in ("task-one", "task-two")
    ]
    pins = {task["id"]: {"sha": task_sha, "oracle_digest": "e" * 64} for task in tasks}
    monkeypatch.setattr(release_report, "suite_binding", lambda: ([dict(task) for task in tasks], DIGEST, pins))
    return tmp_path, task_sha, runtimes


def run_prepare(monkeypatch, root, runtime, task_repo):
    out = root / "prepared" / runtime
    monkeypatch.setattr(
        "sys.argv",
        [
            "release-report",
            "prepare",
            "--repo",
            str(root / runtime),
            "--task-repo",
            str(task_repo),
            "--out",
            str(out),
            "--model",
            "gpt-6.1-sol",
            "--effort",
            "medium",
        ],
    )
    release_report.main()
    return yaml.safe_load((out / "tasks.yaml").read_text())["tasks"], json.loads((out / "metadata.json").read_text())


def test_prepare_grades_both_runtimes_against_one_task_dependency_checkout(prepare_suite, monkeypatch):
    root, _, runtimes = prepare_suite
    prepared = {name: run_prepare(monkeypatch, root, name, root / "tasks-base") for name in runtimes}
    (stable_tasks, stable_meta), (candidate_tasks, candidate_meta) = prepared["stable"], prepared["candidate"]
    # Task source and staged dependencies come from the pinned task checkout,
    # identical for both runtimes; only runtime_sha differs.
    assert {task["repo"] for task in stable_tasks + candidate_tasks} == {str((root / "tasks-base").resolve())}
    assert stable_tasks == candidate_tasks
    assert stable_meta["runtime_sha"] == runtimes["stable"]
    assert candidate_meta["runtime_sha"] == runtimes["candidate"]


def test_prepare_rejects_a_dependency_checkout_at_another_commit(prepare_suite, monkeypatch):
    root, _, _ = prepare_suite
    with pytest.raises(SystemExit) as exc:
        run_prepare(monkeypatch, root, "candidate", root / "candidate")
    assert exc.value.code == 2
    assert not (root / "prepared" / "candidate" / "tasks.yaml").exists()


def test_task_sha_names_the_single_pinned_task_commit(prepare_suite, monkeypatch, capsys):
    _, task_sha, _ = prepare_suite
    monkeypatch.setattr("sys.argv", ["release-report", "task-sha"])
    release_report.main()
    assert capsys.readouterr().out == f"{task_sha}\n"


def test_tasks_pinned_to_different_commits_cannot_share_a_dependency_checkout():
    assert pinned_task_sha([{"ref": "a" * 40}, {"ref": "a" * 40}]) == "a" * 40
    with pytest.raises(ValueError, match="one pinned commit"):
        pinned_task_sha([{"ref": "a" * 40}, {"ref": "b" * 40}])


def test_shipped_release_tasks_share_one_pinned_commit():
    tasks, _, _ = release_report.suite_binding()
    # The workflow builds exactly one dependency checkout for the whole suite.
    assert pinned_task_sha(tasks) == tasks[0]["ref"]


@pytest.mark.parametrize(
    "smuggle",
    [
        lambda report: report["per_run"][0].update(internal_path="/home/runner/private/transcript.jsonl"),
        lambda report: report.update(transcripts=["private"]),
    ],
    ids=["per-run-field", "top-level-field"],
)
def test_evidence_with_fields_outside_the_published_schema_is_rejected(smuggle):
    report = json.loads(json.dumps(build_report(rows(), metadata(), now=NOW)))
    validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)
    smuggle(report)
    with pytest.raises(ValueError, match="outside the published report schema"):
        validate_report(report, runtime_sha=SHA, task_set_digest=DIGEST, now=NOW)


@pytest.mark.parametrize("field", ["cost_usd", "duration_s"])
def test_oversized_integer_measurements_mark_evidence_incomplete_instead_of_crashing(field):
    measured = rows()
    measured[0][field] = 10**400
    report = build_report(measured, metadata(), now=NOW)
    assert report["complete"] is False
    assert any("untrustworthy measurement" in problem for problem in report["problems"])
