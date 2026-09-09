"""A whole sweep, offline: real runner, real sessions, scripted model.

The layers between a model turn and a promotion decision had never been
exercised together. Unit tests covered each in isolation and the paid runs that
would have covered the composition kept dying, so the contracts BETWEEN them
went unverified - and that is where this harness has repeatedly shipped bugs.

This drives runner.main() the way the workflow does. Everything is real: task
selection, hidden-oracle capture, the sandbox, the CLI subprocess, artifact
capture, review scoring against the oracle, aggregation, the health guard, and
the promotion gate. Only the model is scripted, through MockProvider.

Two provisioning steps are stubbed because this environment cannot supply them,
and neither is harness logic: the pinned gitnexus runtime mounts (no
node_modules in a worktree) and the sanitized graph build (needs the gitnexus
CLI at a mounted path). Containment is host-unsafe here; bubblewrap stays with
the real-sandbox canary in the containment job.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import os
import shutil

import pytest

from workflow_bench import oracle_assets, runner
from workflow_bench.mock_provider import MockProvider, Reply

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude.py"
ARMS = ("ce_review", "review", "candidate_review")

# When set, the sweep runs with NOTHING provisioning-stubbed: real bubblewrap
# containment, the real pinned runtime mounts, and the real sanitized graph
# build. The named CI job installs all three, so a missing one there is a
# regression rather than an unsupported machine - it FAILS instead of quietly
# degrading to the stubbed path, which is the whole point of the gate.
FULL_SWEEP_ENV = "GITNEXUS_REQUIRE_FULL_SWEEP"
FULL_SWEEP = os.environ.get(FULL_SWEEP_ENV) == "1"

# The runner refuses --unsafe-no-bwrap whenever CI is set, because that mode runs
# sessions with bypassPermissions behind a boundary its own docstring calls "not
# a security boundary". Deleting CI to get past that refusal would run an
# uncontained agent sweep on the runner holding the checkout and credentials, so
# the stubbed path is skipped under CI instead. The containment job sets
# GITNEXUS_REQUIRE_FULL_SWEEP=1 and takes the real bubblewrap path, so CI keeps
# its coverage; only the uncontained convenience run is given up.
pytestmark = pytest.mark.skipif(
    not FULL_SWEEP and bool(os.environ.get("CI")),
    reason="an uncontained sweep must not run in CI; the containment job runs it with GITNEXUS_REQUIRE_FULL_SWEEP=1",
)

# The review output and the hidden labels are DELIBERATELY different shapes -
# the labels carry line_start/line_end and no recommendation. Only a real run
# surfaces that; it is why these are written out rather than shared.
FINDING = {
    "id": "f1", "severity": "high", "category": "correctness", "path": "src/sum.js",
    "line": 1, "end_line": 1, "blocking": True, "scenario": "review-defect",
    "evidence": "export const total = (a, b) => a - b;", "recommendation": "use a + b",
}
LABEL = {"id": "f1", "severity": "high", "category": "correctness",
         "path": "src/sum.js", "line_start": 1, "line_end": 1}
SECOND_LABEL = {"id": "f2", "severity": "high", "category": "correctness",
                "path": "src/scale.js", "line_start": 1, "line_end": 1}
SECOND_FINDING = {
    "id": "f2", "severity": "high", "category": "correctness", "path": "src/scale.js",
    "line": 1, "end_line": 1, "blocking": True, "scenario": "review-defect",
    "evidence": "export const twice = (n) => n + 2;", "recommendation": "use n * 2",
}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def bench(tmp_path: Path):
    """A self-contained corpus: one repo, one task, one hidden label."""

    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "sum.js").write_text("export const total = (a, b) => a - b;\n")
    (repo / "src" / "scale.js").write_text("export const twice = (n) => n + 2;\n")
    _git(repo, "init", "-q", ".")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fixture")
    sha = _git(repo, "rev-parse", "HEAD")

    oracles = tmp_path / "oracles"
    oracles.mkdir()
    (oracles / "review-fixture-defect.labels.json").write_text(
        json.dumps({"schema_version": 1, "findings": [LABEL]})
    )
    (oracles / "review-fixture-second.labels.json").write_text(
        json.dumps({"schema_version": 1, "findings": [SECOND_LABEL]})
    )

    tasks = tmp_path / "tasks.yaml"
    tasks.write_text(
        "tasks:\n"
        "  - id: review-fixture-defect\n"
        "    class: review-defect\n"
        f"    repo: {repo}\n"
        f"    ref: {sha}\n"
        "    prompt: Review this change and report actionable defects.\n"
        '    verify: test -s "$GITNEXUS_BENCH_REVIEW_OUTPUT"\n'
        "    oracle:\n"
        '      command: test -s "$GITNEXUS_BENCH_REVIEW_OUTPUT"\n'
        "      files: [{ source: review-fixture-defect.labels.json, target: review-labels.json }]\n"
        # A SECOND task, because the thing a cross-task scheduler changes is
        # invisible with one: waves are per-task, so a single task cannot show
        # ordering, packing, or a breaker that spans a task boundary.
        "  - id: review-fixture-second\n"
        "    class: review-defect\n"
        f"    repo: {repo}\n"
        f"    ref: {sha}\n"
        "    prompt: Review the scaling helper and report actionable defects.\n"
        '    verify: test -s "$GITNEXUS_BENCH_REVIEW_OUTPUT"\n'
        "    oracle:\n"
        '      command: test -s "$GITNEXUS_BENCH_REVIEW_OUTPUT"\n'
        "      files: [{ source: review-fixture-second.labels.json, target: review-labels.json }]\n"
    )

    plugin = tmp_path / "ce-plugin"
    (plugin / ".claude-plugin").mkdir(parents=True)
    (plugin / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "compound-engineering", "version": "0.0.0-fixture"})
    )
    for skill in ("ce-plan", "ce-work", "ce-code-review"):
        directory = plugin / "skills" / skill
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(f"---\nname: {skill}\ndescription: fixture\n---\nFixture.\n")

    overlay = tmp_path / "overlay" / ".claude" / "skills" / "gitnexus-review"
    overlay.mkdir(parents=True)
    (overlay / "SKILL.md").write_text("---\nname: gitnexus-review\ndescription: fixture\n---\nCandidate.\n")

    return SimpleNamespace(tasks=tasks, oracles=oracles, plugin=plugin,
                           overlay=tmp_path / "overlay", out=tmp_path / "out")


def _stub_provisioning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace what this machine cannot supply - and nothing else.

    Under FULL_SWEEP nothing is replaced: the runtime mounts and the graph are
    built for real, so the sweep exercises containment and provisioning too.
    """

    if FULL_SWEEP:
        if shutil.which("bwrap") is None:
            pytest.fail(f"{FULL_SWEEP_ENV}=1 but bubblewrap is absent")
        return

    monkeypatch.setattr(runner, "trusted_gitnexus_runtime_mounts", lambda: ())

    def materialize(worktree, *, sanitized_head=None, **_kwargs):
        # The one-clone registry guard reads this before any session runs.
        meta = Path(worktree) / ".gitnexus"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "meta.json").write_text(
            json.dumps({"indexedAt": "2026-09-08T00:00:00Z", "lastCommit": sanitized_head or "0" * 40})
        )

    def fake_graph(**kwargs):
        kwargs["env"].graph_snapshots[kwargs["graph_key"]] = SimpleNamespace(
            digest="fixture-graph", manifest_digest="fixture-graph-manifest",
            dependency_content_digest=None, dependency_manifest_digest=None,
            materialize=materialize,
        )

    monkeypatch.setattr(runner, "ensure_task_graph", fake_graph)


def _sweep(bench, monkeypatch: pytest.MonkeyPatch, findings: list[dict], verdict: str, *, invoke_skill: bool = True):
    """Run the real CLI against a model scripted to return `findings`."""

    _stub_provisioning(monkeypatch)
    monkeypatch.setattr(
        oracle_assets, "ORACLE_ROOT", bench.oracles, raising=False
    )
    monkeypatch.setattr(
        runner, "capture_task_oracles",
        lambda tasks, root=bench.oracles: oracle_assets.capture_task_oracles(tasks, root=root),
    )
    def review_for(body: str) -> str:
        # Per task: the second task's defect is in another file, so replying
        # with the first task's finding would score it wrong. A cross-task
        # scheduler makes which task a request belongs to load-bearing.
        chosen = findings
        if findings and "scaling helper" in body:
            chosen = [SECOND_FINDING if f is FINDING else f for f in findings]
        return json.dumps({"schema_version": 1, "verdict": verdict, "findings": chosen})

    class Scripted(MockProvider):
        def next_reply(self) -> Reply:
            body = json.dumps(self.requests[-1].body if self.requests else {})
            target = re.search(r"(/[^\s\"']*review-output\.json)", body)
            skill = re.search(r"\b(gitnexus-review|ce-code-review)\b", body)
            return Reply(
                text="reviewing",
                tools=[
                    # The evidence gate needs a Skill request with a non-error
                    # result: a review that never invoked its skill measured the
                    # model, not the skill.
                    *([{"name": "Skill", "input": {"skill": skill.group(1) if skill else "gitnexus-review"}}]
                      if invoke_skill else []),
                    {"name": "Write", "input": {
                        "file_path": target.group(1) if target else str(bench.out / "unmatched-review-output.json"),
                        "content": review_for(body)}},
                ],
                input_tokens=2_000, output_tokens=300,
                cache_read_input_tokens=7_000, cache_creation_input_tokens=1_000,
            )

    with Scripted() as provider:
        monkeypatch.setattr(sys, "argv", [
            "runner", "--tasks", str(bench.tasks), "--arms", *ARMS,
            "--runs", "1", "--workers", "1", "--out", str(bench.out),
            "--base-url", provider.base_url, "--anthropic-api-key", "offline",
            "--claude-bin", str(FAKE_CLI),
            *([] if FULL_SWEEP else ["--unsafe-no-bwrap"]),
            "--model", "mock-model",
            "--ce-plugin-dir", str(bench.plugin), "--ce-plugin-version", "0.0.0-fixture",
            "--candidate-overlay", str(bench.overlay),
        ])
    
        try:
            code = runner.main()
        except SystemExit as exc:
            code = exc.code

    rows = [json.loads(line) for line in (bench.out / "results.jsonl").read_text().splitlines()]
    return code, rows, provider


def _row(rows: list[dict], arm: str, task: str = "review-fixture-defect") -> dict:
    return next(r for r in rows if r["arm"] == arm and r["task"] == task)


def test_a_correct_review_scores_and_the_sweep_exits_clean(bench, monkeypatch) -> None:
    """The whole path, green: every arm measured, scored, and accounted for."""

    code, rows, provider = _sweep(bench, monkeypatch, [FINDING], "request_changes")

    assert code in (None, 0), f"sweep did not succeed: {code}"
    tasks = {"review-fixture-defect", "review-fixture-second"}
    assert len(rows) == len(ARMS) * len(tasks)
    assert len(provider.requests) == len(ARMS) * len(tasks), "each cell must reach the provider once"
    assert {r["task"] for r in rows} == tasks, "both tasks must have run"

    row = _row(rows, "review")
    assert row["ok"] is True and row["resolved"] is True
    assert row["skill_invoked"] is True
    assert (row["review_true_positives"], row["review_false_positives"], row["review_false_negatives"]) == (1, 0, 0)
    assert row["review_f1"] == 1.0
    # The provider's own numbers survived the CLI, the parser and the row.
    assert row["cache_read_input_tokens"] == 7_000
    assert row["input_tokens"] == 2_000

    # Each task scored against ITS OWN oracle. This is what a cross-task
    # scheduler puts at risk: interleaving cells from different tasks means a
    # mis-routed context or artifact scores one task against another's labels,
    # and both would still look "green" per row.
    second = _row(rows, "review", task="review-fixture-second")
    assert second["resolved"] is True and second["review_f1"] == 1.0
    assert second["review_artifact"] == "review-fixture-second-review-run0.review.json"

    for name in ("results.jsonl", "report.md", "promotion.json"):
        assert (bench.out / name).is_file(), f"{name} was not written"
    assert (bench.out / "review-fixture-defect-review-run0.review.json").is_file()


def test_one_run_cannot_promote_a_candidate(bench, monkeypatch) -> None:
    """The gate refuses on insufficient paired runs, and says so."""

    _code, _rows, _provider = _sweep(bench, monkeypatch, [FINDING], "request_changes")
    promotion = json.loads((bench.out / "promotion.json").read_text())

    assert promotion["run_status"] == "complete"
    decision = next(d for d in promotion["decisions"] if d["candidate_arm"] == "candidate_review")
    assert decision["decision"] == "insufficient_evidence"
    assert any("valid paired runs" in reason for reason in decision["reasons"])


def test_a_finding_in_the_wrong_place_scores_zero_but_stays_valid_evidence(bench, monkeypatch) -> None:
    """Being wrong is a quality result, not a broken measurement.

    The negative control that makes the passing case mean something: same
    harness, same well-formed artifact, only the answer changed.
    """

    wrong = {**FINDING, "path": "src/WRONG.js", "line": 99, "end_line": 99}
    _code, rows, _provider = _sweep(bench, monkeypatch, [wrong], "request_changes")

    row = _row(rows, "review")
    assert (row["review_true_positives"], row["review_false_positives"], row["review_false_negatives"]) == (0, 1, 1)
    assert row["review_f1"] == 0.0
    assert row["resolved"] is False
    assert row["error_kind"] == "oracle-failed", "a wrong answer is not a session or evidence failure"
    assert row["review_evidence_valid"] is True, "the artifact was well formed; only the answer was wrong"


def test_approving_defective_code_is_a_miss_with_no_false_positive(bench, monkeypatch) -> None:
    """The other half of the control: silence scores differently from a wrong guess."""

    _code, rows, _provider = _sweep(bench, monkeypatch, [], "approve")

    row = _row(rows, "review")
    assert (row["review_true_positives"], row["review_false_positives"], row["review_false_negatives"]) == (0, 0, 1)
    assert row["review_precision"] is None, "precision is undefined with no predictions, not zero"
    assert row["review_verdict_correct"] is False, "approving defective code is the wrong verdict"
    assert row["review_evidence_valid"] is True


def test_a_review_that_never_invoked_its_skill_is_not_a_measurement(bench, monkeypatch) -> None:
    """The gate that separates measuring a SKILL from measuring a model.

    Added because a mutation exposed it: forcing skill_was_invoked_events to
    return True left every other test here passing, so nothing pinned the gate.
    The artifact is written and correct in this run - only the skill request is
    missing - so a pass would mean the arm scored a review it never performed.
    """

    code, rows, _provider = _sweep(bench, monkeypatch, [FINDING], "request_changes", invoke_skill=False)

    row = _row(rows, "review")
    assert row["skill_invoked"] is False
    assert row["error_kind"] == "skill-not-invoked"
    assert code not in (None, 0), "the sweep must not report success on unusable evidence"

    # The row still carries its own score - the artifact was well formed - but
    # aggregate() now keeps it out of the arm's QUALITY median, since a cell
    # whose skill never ran did not measure that skill. It still counts for
    # cost, because the session ran and was billed.
    assert row["review_weighted_f1"] == 1.0
    assert row["review_evidence_valid"] is True
