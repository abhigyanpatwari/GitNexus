import json
import subprocess
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from workflow_bench import release_evidence
from workflow_bench.release_evidence import eligible_runs
from workflow_bench.release_report import build_report

RUNTIME = "a" * 40
HARNESS = "e" * 40
EVALUATOR = "9" * 40
DIGEST = "b" * 64
PINS = {"one": {"sha": "c" * 40, "oracle_digest": "d" * 64}}
TRUSTED_RUN = {
    "conclusion": "success",
    "head_branch": "main",
    "event": "workflow_dispatch",
    "head_repository": {"full_name": "owner/repo"},
}


def test_only_successful_trusted_release_workflow_runs_are_eligible():
    trusted = {**TRUSTED_RUN, "id": 10, "head_sha": HARNESS}
    candidates = [
        trusted,
        *[
            {**trusted, **overrides}
            for overrides in (
                {"id": 11, "conclusion": "failure"},
                {"id": 12, "head_branch": "feature"},
                {"id": 13, "event": "pull_request"},
                {"id": 14, "head_repository": {"full_name": "fork/repo"}},
                {"id": "15"},
                {"id": 16, "head_sha": "E" * 40},
                {"id": 17, "head_sha": None},
            )
        ],
    ]
    assert eligible_runs({"workflow_runs": candidates}, "owner/repo") == [(10, HARNESS)]


def make_report(*, harness_sha: str = HARNESS, runtime_sha: str = RUNTIME) -> dict[str, Any]:
    metadata = dict(
        runtime_sha=runtime_sha,
        harness_sha=harness_sha,
        task_set_digest=DIGEST,
        model="gpt-6.1-sol",
        effort="medium",
        runs=3,
        tasks=PINS,
    )
    measured = [
        dict(
            task="one",
            run=i,
            arm=arm,
            model=metadata["model"],
            effort="medium",
            task_base_sha=PINS["one"]["sha"],
            oracle_digest=PINS["one"]["oracle_digest"],
            sandbox_backend="bwrap",
            ok=True,
            resolved=True,
            authored_tests_passed=True,
            oracle_passed=True,
            error_kind=None,
            transcript_missing=False,
            cost_usd=1,
            duration_s=1,
        )
        for i in range(3)
        for arm in ("baseline_nomcp", "baseline")
    ]
    return build_report(measured, metadata, now=datetime.now(UTC))


@dataclass
class FakeGitHub:
    """Workflow runs (newest first), their artifact reports and one main comparison."""

    runs: list[dict[str, Any]]
    reports: dict[str, Any]
    artifact: dict[str, Any]
    comparison: dict[str, Any] = field(
        default_factory=lambda: {"status": "ahead", "files": [{"filename": "gitnexus/src/cli/index.ts"}]}
    )
    endpoints: list[str] = field(default_factory=list)
    downloads: list[list[str]] = field(default_factory=list)
    download_options: list[dict[str, Any]] = field(default_factory=list)

    def api(self, endpoint: str) -> dict[str, Any]:
        self.endpoints.append(endpoint)
        routes = {
            "/compare/": self.comparison,
            "/artifacts?": {"artifacts": [self.artifact]},
            "/workflows/release-evaluation.yml/runs?": {"workflow_runs": self.runs},
        }
        return next(payload for marker, payload in routes.items() if marker in endpoint)

    def download(self, command: list[str], **options: Any) -> subprocess.CompletedProcess[str]:
        self.downloads.append(command)
        self.download_options.append(options)
        destination = Path(command[-1])
        (destination / "agent-evaluation.json").write_text(json.dumps(self.reports[command[3]]))
        (destination / "agent-evaluation.md").write_text("untrusted downloaded prose")
        return subprocess.CompletedProcess(command, 0, "", "")

    def add_run(self, run_id: int, report: Any, head_sha: str = HARNESS) -> None:
        self.runs.append({**TRUSTED_RUN, "id": run_id, "head_sha": head_sha})
        self.reports[str(run_id)] = report


@pytest.fixture
def github(monkeypatch) -> FakeGitHub:
    fake = FakeGitHub(runs=[], reports={}, artifact={"name": f"release-agent-evaluation-{RUNTIME}", "expired": False})
    fake.add_run(10, make_report())
    monkeypatch.setattr(release_evidence, "suite_binding", lambda: ([], DIGEST, PINS))
    monkeypatch.setattr(release_evidence, "_gh_json", fake.api)
    monkeypatch.setattr(release_evidence.subprocess, "run", fake.download)
    return fake


def download(out: Path) -> None:
    release_evidence.download_evidence("owner/repo", RUNTIME, out, evaluator_sha=EVALUATOR)


def test_publisher_regenerates_summary_from_verified_exact_revision_cells(tmp_path, github):
    download(tmp_path)
    assert json.loads((tmp_path / "agent-evaluation.json").read_text()) == github.reports["10"]
    summary = (tmp_path / "agent-evaluation.md").read_text()
    assert "3/3" in summary
    assert "untrusted downloaded prose" not in summary
    assert github.downloads[0][:4] == ["gh", "run", "download", "10"]
    assert f"repos/owner/repo/compare/{HARNESS}...{EVALUATOR}" in github.endpoints


def test_wrong_revision_inside_named_artifact_blocks_publishing(tmp_path, github):
    github.reports["10"]["runtime_sha"] = "f" * 40
    with pytest.raises(ValueError, match="different runtime"):
        download(tmp_path)
    assert not (tmp_path / "agent-evaluation.json").exists()


def test_expired_artifact_is_not_downloaded_or_accepted(tmp_path, github):
    github.artifact["expired"] = True
    with pytest.raises(ValueError, match="No complete paired"):
        download(tmp_path)
    assert github.downloads == []


def test_evidence_beyond_the_first_page_of_recent_runs_is_found(tmp_path, github, monkeypatch):
    filler = [{**TRUSTED_RUN, "id": index, "event": "push", "head_sha": HARNESS} for index in range(100)]
    # The first page holds only ineligible runs; valid evidence is on page 2.
    run_pages = iter([{"workflow_runs": filler}, {"workflow_runs": github.runs}])

    def api(endpoint):
        return next(run_pages) if "/runs?" in endpoint else github.api(endpoint)

    monkeypatch.setattr(release_evidence, "_gh_json", api)
    download(tmp_path)
    assert json.loads((tmp_path / "agent-evaluation.json").read_text()) == github.reports["10"]
    assert github.downloads[0][:4] == ["gh", "run", "download", "10"]


def test_recent_runs_are_paged_within_the_evidence_window(monkeypatch):
    endpoints = []
    pages = iter([{"workflow_runs": [{"id": index} for index in range(100)]}, {"workflow_runs": []}])
    monkeypatch.setattr(release_evidence, "_gh_json", lambda endpoint: endpoints.append(endpoint) or next(pages))
    assert list(release_evidence._recent_runs("owner/repo")) == []
    assert [endpoint[-6:] for endpoint in endpoints] == ["page=1", "page=2"]
    assert all("created=%3E%3D" in endpoint for endpoint in endpoints)


@pytest.mark.parametrize(
    "plant",
    [
        lambda folder, report: (folder / "other.json").write_text(json.dumps(report)),
        lambda folder, report: (folder / "agent-evaluation.json").symlink_to(folder / "elsewhere.json"),
        lambda folder, report: (folder / "agent-evaluation.json").write_text(" " * (2 * 1024 * 1024 + 1)),
    ],
    ids=["missing", "symlink", "oversized"],
)
def test_unsafe_or_missing_artifact_file_blocks_publishing(tmp_path, github, monkeypatch, plant):
    (tmp_path / "elsewhere.json").write_text(json.dumps(github.reports["10"]))

    def planted(command, **options):
        plant(Path(command[-1]), github.reports["10"])
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(release_evidence.subprocess, "run", planted)
    with pytest.raises(ValueError, match="invalid release evidence artifact"):
        download(tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_report_measured_on_different_task_pins_blocks_publishing(tmp_path, github, monkeypatch):
    monkeypatch.setattr(release_evidence, "suite_binding", lambda: ([], DIGEST, {"other": {}}))
    with pytest.raises(ValueError, match="task pins"):
        download(tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_report_from_a_different_harness_than_its_run_is_rejected(tmp_path, github):
    # A trusted run's artifact cannot vouch for a report another harness produced.
    github.reports["10"] = make_report(harness_sha="7" * 40)
    with pytest.raises(ValueError, match=f"harness_sha is not the commit workflow run 10 ran \\({HARNESS}\\)"):
        download(tmp_path / "out")
    assert not (tmp_path / "out").exists()
    assert not any("/compare/" in endpoint for endpoint in github.endpoints)


@pytest.mark.parametrize(
    ("comparison", "reason"),
    [
        ({"status": "ahead", "files": [{"filename": "eval/workflow_bench/oracles/retry/test.mjs"}]}, "inputs changed"),
        ({"status": "ahead", "files": [{"filename": "x.py", "previous_filename": "eval/grade.py"}]}, "inputs changed"),
        ({"status": "ahead", "files": [{"filename": ".github/workflows/release-evaluation.yml"}]}, "inputs changed"),
        ({"status": "ahead", "files": [{"filename": ".github/claude-canary-runtime/package.json"}]}, "inputs changed"),
        ({"status": "diverged", "files": []}, "not an ancestor"),
        ({"status": "behind", "files": []}, "not an ancestor"),
        ({"status": "ahead", "files": [{"filename": f"docs/{i}.md"} for i in range(300)]}, "truncated"),
        ({"status": "ahead"}, "truncated"),
        ({"status": "ahead", "files": [{"sha": "f" * 40}]}, "malformed compare file entry"),
    ],
    ids=["oracle", "renamed-out", "workflow", "agent-cli", "diverged", "behind", "file-cap", "no-files", "malformed"],
)
def test_evidence_from_a_harness_that_main_has_since_changed_is_rejected(tmp_path, github, comparison, reason):
    github.comparison = comparison
    with pytest.raises(ValueError, match=reason):
        download(tmp_path / "out")
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize(
    ("comparison", "evaluator"),
    [
        ({"status": "identical", "files": []}, HARNESS),
        (
            {"status": "ahead", "files": [{"filename": "gitnexus/eval/x.ts", "previous_filename": "docs/eval/x"}]},
            EVALUATOR,
        ),
    ],
    ids=["same-commit", "unrelated-change"],
)
def test_harness_stays_current_while_main_leaves_evaluation_inputs_alone(monkeypatch, comparison, evaluator):
    endpoints = []
    monkeypatch.setattr(release_evidence, "_gh_json", lambda endpoint: endpoints.append(endpoint) or comparison)
    release_evidence.require_current_harness("owner/repo", HARNESS, evaluator)
    assert endpoints == [f"repos/owner/repo/compare/{HARNESS}...{evaluator}"]


def test_a_rejected_newer_run_does_not_hide_older_valid_evidence(tmp_path, github):
    github.runs.clear()
    github.add_run(30, make_report(runtime_sha="f" * 40))
    github.add_run(20, make_report(harness_sha="7" * 40))
    github.add_run(10, make_report())
    download(tmp_path)
    assert [command[3] for command in github.downloads] == ["30", "20", "10"]
    assert json.loads((tmp_path / "agent-evaluation.json").read_text()) == github.reports["10"]


def test_without_valid_evidence_every_rejected_run_is_listed(tmp_path, github):
    github.runs.clear()
    github.add_run(30, make_report(runtime_sha="f" * 40))
    github.add_run(20, ["not", "a", "report"])
    github.add_run(10, {"harness_sha": HARNESS})
    with pytest.raises(ValueError) as rejected:
        download(tmp_path / "out")
    lines = str(rejected.value).splitlines()
    assert lines[1:] == [
        "Rejected evidence:",
        "- run 30: release evidence belongs to a different runtime or task set",
        f"- run 20: report harness_sha is not the commit workflow run 20 ran ({HARNESS})",
        "- run 10: incomplete or unsupported release evidence",
    ]
    assert not (tmp_path / "out").exists()


def test_rejection_list_is_bounded(tmp_path, github):
    github.runs.clear()
    for run_id in range(25, 0, -1):
        github.add_run(run_id, make_report(runtime_sha="f" * 40))
    with pytest.raises(ValueError) as rejected:
        download(tmp_path / "out")
    lines = str(rejected.value).splitlines()
    assert len(lines) == 2 + release_evidence.MAX_REASONS + 1
    assert lines[-1] == "- ... and 5 more rejected run(s)"


def test_artifact_download_is_time_bounded(tmp_path, github):
    download(tmp_path)
    assert github.download_options[0]["timeout"] == release_evidence.GH_TIMEOUT_S


def test_api_requests_are_time_bounded(monkeypatch):
    calls = []

    def gh(command, **options):
        calls.append((command, options.get("timeout")))
        return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")

    monkeypatch.setattr(release_evidence.subprocess, "run", gh)
    assert release_evidence._gh_json("repos/owner/repo") == {"ok": True}
    assert calls == [(["gh", "api", "repos/owner/repo"], release_evidence.GH_TIMEOUT_S)]


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (subprocess.TimeoutExpired(["gh"], 120), "gh run timed out after 120s"),
        (subprocess.CalledProcessError(1, ["gh"], stderr="HTTP 502 token=secret"), "gh run failed with exit status 1"),
    ],
    ids=["timeout", "error"],
)
def test_stalled_or_failed_download_rejects_that_run_without_leaking_output(
    tmp_path, github, monkeypatch, failure, reason
):
    def fail(command, **options):
        raise failure

    monkeypatch.setattr(release_evidence.subprocess, "run", fail)
    with pytest.raises(ValueError, match=f"- run 10: {reason}$") as rejected:
        download(tmp_path / "out")
    assert "secret" not in str(rejected.value)
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize(
    ("repo", "sha", "evaluator"),
    [
        ("owner/repo;rm", RUNTIME, EVALUATOR),
        ("owner/repo", "a" * 39, EVALUATOR),
        ("owner/repo", "A" * 40, EVALUATOR),
        ("owner/repo", RUNTIME, "main"),
    ],
)
def test_malformed_repository_or_revision_is_rejected_before_any_api_call(tmp_path, github, repo, sha, evaluator):
    with pytest.raises(ValueError, match="full release commit SHA"):
        release_evidence.download_evidence(repo, sha, tmp_path / "out", evaluator_sha=evaluator)
    assert github.endpoints == []
