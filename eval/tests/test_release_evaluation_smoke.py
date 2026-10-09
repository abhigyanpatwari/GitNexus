"""Native, contained prepare → paired runner → hidden grading → public report."""

import json
import os
import subprocess
import sys
from functools import partial
from pathlib import Path

import pytest
import yaml

from workflow_bench import oracle_assets, release_report, runner
from workflow_bench.mock_provider import MockProvider, Reply

pytestmark = pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_CLAUDE_CANARY") != "1",
    reason="the Ubuntu containment job provisions the real pinned CLI, runtime, and Bubblewrap",
)


def test_native_paired_evaluator_produces_valid_report_and_keeps_negative_results(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    repo = tmp_path / "candidate"
    (repo / "src").mkdir(parents=True)
    (repo / "package.json").write_text('{"type":"module"}\n')
    (repo / "src/sum.js").write_text("export function total(a, b) { return a - b; }\n")
    for arguments in (
        ["init", "-q"],
        ["add", "."],
        ["-c", "user.name=Canary", "-c", "user.email=canary@example.test", "commit", "-qm", "fixture"],
    ):
        subprocess.run(["git", "-C", str(repo), *arguments], check=True, capture_output=True)
    sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    oracles = tmp_path / "hidden"
    oracles.mkdir()
    (oracles / "sum.test.mjs").write_text(
        "import assert from 'node:assert/strict';\nimport {total} from '../src/sum.js';\nassert.equal(total(1, 2), 3);\n"
    )
    suite = tmp_path / "suite.yaml"
    suite.write_text(
        yaml.safe_dump(
            {
                "tasks": [
                    {
                        "id": "release-smoke",
                        "class": "bug-fix",
                        "repo": str(repo),
                        "ref": sha,
                        "prompt": "Repair the total function and inspect available repository tools.",
                        "verify": "node --check src/sum.js",
                        "oracle": {
                            "command": 'node "$GITNEXUS_BENCH_ORACLE_ROOT/sum.test.mjs"',
                            "files": [{"source": "sum.test.mjs", "target": "sum.test.mjs"}],
                        },
                    }
                ]
            }
        )
    )
    # Substitute only the small corpus. Provisioning, sessions, hidden grading,
    # row accounting and report validation all remain their production code.
    capture = partial(oracle_assets.capture_task_oracles, root=oracles)
    monkeypatch.setattr(release_report, "capture_task_oracles", capture)
    monkeypatch.setattr(runner, "capture_task_oracles", capture)
    monkeypatch.setattr(release_report, "suite_binding", partial(release_report.suite_binding, suite))
    prepared = tmp_path / "prepared"
    model = "claude-canary-20260718"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "release-report",
            "prepare",
            "--repo",
            str(repo),
            "--task-repo",
            str(repo),
            "--out",
            str(prepared),
            "--model",
            model,
            "--effort",
            "high",
            "--runs",
            "3",
        ],
    )
    release_report.main()
    meta = json.loads((prepared / "metadata.json").read_text())
    assert meta["runtime_sha"] == sha and meta["harness_sha"] == release_report._git_sha(root)

    initial = []
    counts = {"baseline_nomcp": 0, "baseline": 0}

    def arm_for(body):
        text = "\n".join(
            block.get("text", "")
            for message in body.get("messages", [])
            if message.get("role") == "user" and isinstance(message.get("content"), list)
            for block in message["content"]
            if block.get("type") == "text"
        )
        return "baseline_nomcp" if runner.GITNEXUS_UNAVAILABLE_NOTE in text else "baseline"

    class Scripted(MockProvider):
        def next_reply(self):
            body = self.requests[-1].body
            if any(
                block.get("type") == "tool_result"
                for message in body.get("messages", [])
                if isinstance(message.get("content"), list)
                for block in message["content"]
            ):
                return Reply(text="Finished.")
            arm = arm_for(body)
            initial.append((arm, body))
            counts[arm] += 1
            # One real failed repair proves negative outcomes remain measured.
            operator = "-" if arm == "baseline" and counts[arm] == 3 else "+"
            return Reply(
                tools=[
                    *([{"name": "mcp__gitnexus__list_repos", "input": {}}] if arm == "baseline" else []),
                    {
                        "name": "Bash",
                        "input": {
                            "command": f"printf '%s\\n' 'export function total(a, b) {{ return a {operator} b; }}' > /workspace/src/sum.js"
                        },
                    },
                ]
            )

    raw = prepared / "raw"
    with Scripted() as provider:
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "runner",
                "--tasks",
                str(prepared / "tasks.yaml"),
                "--gitnexus-root",
                str(root),
                "--arms",
                "baseline_nomcp",
                "baseline",
                "--runs",
                "3",
                "--workers",
                "1",
                "--timeout",
                "60",
                "--model",
                model,
                "--effort",
                "high",
                "--claude-bin",
                os.environ["CLAUDE_CANARY_BIN"],
                "--base-url",
                provider.base_url,
                "--anthropic-api-key",
                "offline-canary-key",
                "--out",
                str(raw),
            ],
        )
        assert runner.main() in (None, 0)
    assert counts == {"baseline_nomcp": 3, "baseline": 3}
    assert len(initial) == 6
    rows = [json.loads(line) for line in (raw / "results.jsonl").read_text().splitlines()]
    assert len(rows) == 6
    assert all(row["ok"] is True and row["sandbox_backend"] == "bwrap" for row in rows)
    assert sum(row["resolved"] for row in rows) == 5
    assert sum(row["oracle_passed"] is False for row in rows) == 1
    for arm, body in initial:
        advertised = {tool["name"] for tool in body["tools"]}
        assert "Skill" not in advertised
        if arm == "baseline_nomcp":
            assert not any(name.startswith("mcp__") for name in advertised)
    mcp_results = [
        block
        for request in provider.requests
        if arm_for(request.body) == "baseline"
        for message in request.body.get("messages", [])
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if block.get("type") == "tool_result" and block.get("tool_use_id") == "toolu_mock_0"
    ]
    assert len(mcp_results) == 3
    assert all(block.get("is_error") is not True for block in mcp_results)
    public = prepared / "public"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "release-report",
            "summarize",
            "--results",
            str(raw / "results.jsonl"),
            "--metadata",
            str(prepared / "metadata.json"),
            "--out",
            str(public),
        ],
    )
    release_report.main()
    report = json.loads((public / "agent-evaluation.json").read_text())
    assert report["complete"] is True, report["problems"]
    assert report["arms"]["baseline_nomcp"]["solved"] == 3
    assert report["arms"]["baseline"]["solved"] == 2
    monkeypatch.setattr(
        sys,
        "argv",
        ["release-report", "check", "--evidence", str(public / "agent-evaluation.json"), "--runtime-sha", sha],
    )
    release_report.main()
    assert "oracle-failed" in (public / "agent-evaluation.json").read_text()
    assert "offline-canary-key" not in (public / "agent-evaluation.json").read_text()
    assert "-1" in (public / "agent-evaluation.md").read_text()
