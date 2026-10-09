import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from workflow_bench import release_evidence
from workflow_bench.release_evidence import eligible_runs
from workflow_bench.release_report import build_report


def test_only_successful_trusted_release_workflow_runs_are_eligible():
    trusted = {
        "id": 10,
        "conclusion": "success",
        "head_branch": "main",
        "event": "workflow_dispatch",
        "head_repository": {"full_name": "owner/repo"},
    }
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
            )
        ],
    ]
    assert eligible_runs({"workflow_runs": candidates}, "owner/repo") == [10]


@pytest.fixture
def evidence_backend(monkeypatch):
    sha = "a" * 40
    digest = "b" * 64
    pins = {"one": {"sha": "c" * 40, "oracle_digest": "d" * 64}}
    metadata = dict(
        runtime_sha=sha,
        harness_sha="e" * 40,
        task_set_digest=digest,
        model="gpt-6.1-sol",
        effort="medium",
        runs=3,
        tasks=pins,
    )
    measured = [
        dict(
            task="one",
            run=i,
            arm=arm,
            model=metadata["model"],
            effort="medium",
            task_base_sha=pins["one"]["sha"],
            oracle_digest=pins["one"]["oracle_digest"],
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
    report = build_report(measured, metadata, now=datetime.now(UTC))
    monkeypatch.setattr(release_evidence, "suite_binding", lambda: ([], digest, pins))
    artifact = {"name": f"release-agent-evaluation-{sha}", "expired": False}

    def api(endpoint):
        if "/artifacts?" in endpoint:
            return {"artifacts": [artifact]}
        return {
            "workflow_runs": [
                {
                    "id": 10,
                    "conclusion": "success",
                    "head_branch": "main",
                    "event": "workflow_dispatch",
                    "head_repository": {"full_name": "owner/repo"},
                }
            ]
        }

    monkeypatch.setattr(release_evidence, "_gh_json", api)
    calls = []

    def download(command, **kwargs):
        calls.append(command)
        destination = Path(command[-1])
        (destination / "agent-evaluation.json").write_text(json.dumps(report))
        (destination / "agent-evaluation.md").write_text("untrusted downloaded prose")

    monkeypatch.setattr(release_evidence.subprocess, "run", download)
    return sha, report, artifact, calls


def test_publisher_regenerates_summary_from_verified_exact_revision_cells(tmp_path, evidence_backend):
    sha, report, _, calls = evidence_backend
    release_evidence.download_evidence("owner/repo", sha, tmp_path)
    assert json.loads((tmp_path / "agent-evaluation.json").read_text()) == report
    summary = (tmp_path / "agent-evaluation.md").read_text()
    assert "3/3" in summary
    assert "untrusted downloaded prose" not in summary
    assert calls[0][:4] == ["gh", "run", "download", "10"]


def test_wrong_revision_inside_named_artifact_blocks_publishing(tmp_path, evidence_backend):
    sha, report, _, _ = evidence_backend
    report["runtime_sha"] = "f" * 40
    with pytest.raises(ValueError, match="different runtime"):
        release_evidence.download_evidence("owner/repo", sha, tmp_path)
    assert not (tmp_path / "agent-evaluation.json").exists()


def test_expired_artifact_is_not_downloaded_or_accepted(tmp_path, evidence_backend):
    sha, _, artifact, calls = evidence_backend
    artifact["expired"] = True
    with pytest.raises(ValueError, match="No complete paired"):
        release_evidence.download_evidence("owner/repo", sha, tmp_path)
    assert calls == []


def test_evidence_beyond_the_first_page_of_recent_runs_is_found(tmp_path, evidence_backend, monkeypatch):
    sha, report, _, calls = evidence_backend
    original = release_evidence._gh_json
    filler = [
        {
            "id": index,
            "conclusion": "success",
            "head_branch": "main",
            "event": "push",
            "head_repository": {"full_name": "owner/repo"},
        }
        for index in range(100)
    ]
    # The first page holds only ineligible runs; valid evidence is on page 2.
    run_pages = iter([{"workflow_runs": filler}, original("runs")])
    endpoints = []

    def api(endpoint):
        endpoints.append(endpoint)
        return original(endpoint) if "/artifacts?" in endpoint else next(run_pages)

    monkeypatch.setattr(release_evidence, "_gh_json", api)
    release_evidence.download_evidence("owner/repo", sha, tmp_path)
    assert json.loads((tmp_path / "agent-evaluation.json").read_text()) == report
    assert calls[0][:4] == ["gh", "run", "download", "10"]
    assert [endpoint[-6:] for endpoint in endpoints[:2]] == ["page=1", "page=2"]
    assert all("created=%3E%3D" in endpoint for endpoint in endpoints[:2])
