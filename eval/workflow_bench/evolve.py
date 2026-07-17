"""Close the skill-evolution loop: propose → benchmark → gate, offline.

The benchmark (runner.py) already isolates prompt candidates, pairs them with
incumbents on the same tasks, and decides promotion deterministically
(evolution.py). This module automates the three arrows that were manual:

1. PROPOSE — one headless Claude session reads the incumbent skills plus the
   trajectory evidence (loser rows, session transcripts, per-run patches, the
   live-task learning queue) and writes ONE bounded candidate overlay.
2. DRIVE  — propose → runner → promotion.json, iterated up to --generations,
   feeding each generation's results back as the next proposer's evidence.
3. APPLY  — on ``promote``, copy the overlay onto the canonical
   ``.claude/skills/`` trees and their shipped mirrors, leaving an ordinary
   working-tree diff for a human-reviewed PR. Nothing is committed or pushed:
   the deterministic gate is evidence FOR a PR, never a bypass of one.

Trust model matches the runner: the proposer session runs with
bypassPermissions inside a throwaway clone of this repo; its only durable
output is the overlay directory, which ``candidate_overlay_files``
re-validates before any benchmark or apply step consumes it.

Usage:
    uv run python -m workflow_bench.evolve \
        --tasks workflow_bench/tasks.scenarios.yaml \
        --model <pinned-model-id> --generations 2 \
        --seed-results results/wfbench-<prior-run>
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any

from . import runner
from .evolution import ARM_SKILLS, CANDIDATE_ARMS, candidate_overlay_files

INCUMBENT_ARMS = {incumbent: cand for cand, incumbent in CANDIDATE_ARMS.items()}
MAX_EVIDENCE_ROWS = 12
MAX_LEARNINGS = 40
VERIFY_TAIL_CHARS = 600
# Shipped byte-identical mirrors of .claude/skills/<name> (see
# gitnexus/test/unit/shipped-skills-sync.test.ts — the drift guard).
MIRROR_SKILL_ROOTS = ("gitnexus/skills", "gitnexus-claude-plugin/skills")
REVIEW_EXTRA_MIRROR = "gitnexus-cursor-integration/skills"
REPO_ROOT = Path(__file__).resolve().parents[2]


# ─── Evidence assembly (pure, unit-tested) ───────────────────────────────────


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read a .jsonl file, skipping blank or malformed lines."""
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def select_evidence(rows: list[dict[str, Any]], max_rows: int = MAX_EVIDENCE_ROWS) -> list[dict[str, Any]]:
    """Pick the runs a proposer should study: failures first, then cost.

    infra-error rows are excluded — the harness died, not the skill, so they
    carry no prompt-attributable signal. Unresolved rows (verify-failed,
    skill-not-invoked, session-error) lead; the most expensive resolved rows
    fill the remainder, because that is where token savings live.
    """
    measured = [r for r in rows if r.get("error_kind") != "infra-error"]
    unresolved = [r for r in measured if not r.get("resolved")]
    resolved = [r for r in measured if r.get("resolved")]
    unresolved.sort(key=lambda r: (str(r.get("task")), str(r.get("arm")), r.get("run", 0)))
    resolved.sort(key=lambda r: float(r.get("cost_usd", 0.0)), reverse=True)
    return (unresolved + resolved)[:max_rows]


def compact_row(row: dict[str, Any]) -> dict[str, Any]:
    """One evidence row, trimmed to what a proposer can actually use."""
    return {
        "task": row.get("task"),
        "class": row.get("class"),
        "arm": row.get("arm"),
        "run": row.get("run"),
        "resolved": row.get("resolved"),
        "error_kind": row.get("error_kind"),
        "cost_usd": row.get("cost_usd"),
        "num_turns": row.get("num_turns"),
        "output_tokens": row.get("output_tokens"),
        "churn": f"{row.get('diff_files', 0)}f/+{row.get('diff_insertions', 0)}/−{row.get('diff_deletions', 0)}",
        "session_ids": row.get("session_ids", []),
        "patch_file": f"{row.get('task')}-{row.get('arm')}-run{row.get('run')}.patch",
        "verify_tail": str(row.get("verify_output", ""))[-VERIFY_TAIL_CHARS:],
    }


def read_learnings(path: Path, cap: int = MAX_LEARNINGS) -> list[dict[str, Any]]:
    """The live-task learning queue, most recent entries last."""
    return load_jsonl(path)[-cap:]


def summarize_gate(promotion: dict[str, Any]) -> list[str]:
    """One line per prior gate decision — the proposer's 'what already lost'."""
    lines = []
    for decision in promotion.get("decisions", []):
        reasons = "; ".join(decision.get("reasons", [])[:3])
        lines.append(f"{decision.get('candidate_arm')}: {decision.get('decision')} — {reasons}")
    return lines


def exercised_skills(incumbent_arms: list[str]) -> list[str]:
    return sorted({skill for arm in incumbent_arms for skill in ARM_SKILLS[arm]})


def build_proposer_prompt(
    *,
    results_dir: Path | None,
    evidence: list[dict[str, Any]],
    learnings: list[dict[str, Any]],
    gate_summary: list[str],
    overlay_dir: Path,
    proposal_path: Path,
    incumbent_arms: list[str],
) -> str:
    skills = exercised_skills(incumbent_arms)
    evidence_block = (
        json.dumps([compact_row(r) for r in evidence], indent=1)
        if evidence
        else "none yet — propose from the learning queue and your own read of the skills"
    )
    learnings_block = json.dumps(learnings, indent=1) if learnings else "empty"
    gate_block = "\n".join(f"- {line}" for line in gate_summary) or "- none yet"
    return f"""You are improving the GitNexus engineering skill family from benchmark
evidence. You are inside a throwaway clone of the GitNexus repo — the
incumbent skills are at .claude/skills/<name>/SKILL.md. Read the ones the
evidence implicates before proposing anything.

## Evidence

- Benchmark results dir: {results_dir if results_dir else "none (first generation)"}
  (full rows in results.jsonl; each run's final working-tree diff is the
  matching *.patch file there).
- Session transcripts: ~/.claude/projects/<slug>/<session_id>.jsonl — glob
  every project dir for a session id. Transcripts show where each session
  actually spent its turns; read at least the transcripts of the unresolved
  runs below before diagnosing.
- Prior promotion-gate decisions (what already lost, and why):
{gate_block}
- Live-task learning queue (appended by real skill runs; hints, not ground
  truth): {learnings_block}

Selected runs (unresolved first, then the most expensive resolved):
{evidence_block}

## Your job

Diagnose ONE recurring failure or cost pattern that the skill text itself
causes, and write ONE bounded prompt change that addresses it. Touch several
files only when they carry the same single change (e.g. the plan and work
halves of one handoff rule).

Rules — the harness re-validates most of these, so a violation wastes the run:

- Write complete replacement files (not diffs) under
  {overlay_dir}/.claude/skills/<skill>/…, Markdown only, and only for skills
  the benchmarked arms exercise: {", ".join(skills)}.
- Start each file as a byte copy of the incumbent and edit it; never write a
  file from scratch.
- Do not modify anything outside {overlay_dir} and {proposal_path} — no task
  files, no verify commands, no source code, no canonical skills.
- Preserve invocation literals that repo tests pin verbatim (e.g. the exact
  string `node .gitnexus/run.cjs analyze`); see
  gitnexus/test/unit/skills-steering.test.ts before rewording any command.
- Never weaken the skills' hard gates: impact-before-edit,
  detect_changes-before-commit, foreground verification.
- Keep the edit small — a rule added, sharpened, or deleted; a budget
  adjusted; a phase reordered. A sprawling rewrite loses in human review even
  if it wins the gate.

Finally write {proposal_path}: the failure pattern (cite task/arm/session
ids), the single change you made, the metric you expect to move and why, and
the risks. That file is the reviewer-facing case for the candidate."""


# ─── Proposer session ────────────────────────────────────────────────────────


def run_proposer(prompt: str, args: argparse.Namespace) -> dict[str, Any]:
    """One headless session in a throwaway clone; returns its usage record."""
    with tempfile.TemporaryDirectory(prefix="wfevolve-") as tmp:
        clone = runner.make_worktree(REPO_ROOT, "HEAD", Path(tmp))
        try:
            return runner.run_claude(
                prompt,
                clone,
                claude_bin=args.claude_bin,
                timeout=args.timeout,
                model=args.proposer_model or args.model,
                env=runner.claude_env(args),
                permission_mode="bypassPermissions",
            )
        finally:
            runner.remove_clone(clone)


# ─── Apply (promote → working-tree diff) ─────────────────────────────────────


def mirror_targets(relative: PurePosixPath) -> list[PurePosixPath]:
    """Every repo path one overlay file lands on: canonical + shipped mirrors."""
    skill = relative.parts[2]
    rest = PurePosixPath(*relative.parts[3:])
    targets = [relative]
    targets += [PurePosixPath(root, skill, rest) for root in MIRROR_SKILL_ROOTS]
    if skill == "gitnexus-review":
        targets.append(PurePosixPath(REVIEW_EXTRA_MIRROR, skill, rest))
    return targets


def apply_promoted_overlay(overlay: Path, repo_root: Path = REPO_ROOT) -> list[str]:
    """Copy a promoted overlay onto the canonical skills and shipped mirrors.

    Re-validates the trust boundary first, so a hand-edited overlay cannot
    smuggle non-skill files into the repo. Returns the written repo-relative
    paths; committing and PR-ing them stays a human step.
    """
    written: list[str] = []
    for source in candidate_overlay_files(overlay):
        relative = PurePosixPath(source.relative_to(overlay.expanduser().resolve()).as_posix())
        for target in mirror_targets(relative):
            destination = repo_root / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
            written.append(target.as_posix())
    return written


# ─── Driver ──────────────────────────────────────────────────────────────────


def runner_argv(args: argparse.Namespace, bench_dir: Path, overlay_dir: Path) -> list[str]:
    argv = [
        sys.executable,
        "-m",
        "workflow_bench.runner",
        "--tasks",
        str(args.tasks),
        "--runs",
        str(args.runs),
        "--model",
        args.model,
        "--claude-bin",
        args.claude_bin,
        "--timeout",
        str(args.timeout),
        "--out",
        str(bench_dir),
        "--candidate-overlay",
        str(overlay_dir),
        "--arms",
        *args.arms,
        *[INCUMBENT_ARMS[arm] for arm in args.arms],
        "--promotion-metric",
        args.promotion_metric,
        "--promotion-min-runs",
        str(args.promotion_min_runs),
        "--promotion-min-improvement",
        str(args.promotion_min_improvement),
        "--promotion-max-task-regression",
        str(args.promotion_max_task_regression),
    ]
    if args.base_url:
        argv += ["--base-url", args.base_url]
    if args.auth_token:
        argv += ["--auth-token", args.auth_token]
    return argv


def promoted_decisions(promotion: dict[str, Any]) -> list[dict[str, Any]]:
    return [d for d in promotion.get("decisions", []) if d.get("decision") == "promote"]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument(
        "--model",
        required=True,
        help="pinned model for the benchmark arms — the promotion gate refuses unnamed models",
    )
    parser.add_argument(
        "--proposer-model",
        default=None,
        help="model for the proposer session (default: --model); diagnosis "
        "quality matters more than cost here, so a stronger model is fine",
    )
    parser.add_argument("--runs", type=int, default=3, help="per arm per task; the gate needs ≥3")
    parser.add_argument("--generations", type=int, default=1)
    parser.add_argument(
        "--arms",
        nargs="+",
        default=list(INCUMBENT_ARMS),
        choices=list(INCUMBENT_ARMS),
        help="incumbent arms to evolve; candidate arms are derived",
    )
    parser.add_argument(
        "--seed-results",
        type=Path,
        default=None,
        help="prior wfbench results dir used as generation-0 proposer evidence",
    )
    parser.add_argument(
        "--initial-overlay",
        type=Path,
        default=None,
        help="skip the generation-0 proposer and benchmark this overlay instead",
    )
    parser.add_argument(
        "--learnings",
        type=Path,
        default=Path(__file__).parent / "learnings.jsonl",
        help="live-task learning queue appended by real skill runs",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="on promote, copy the overlay onto the canonical skills and "
        "shipped mirrors (working-tree only; review/commit stays human)",
    )
    parser.add_argument("--out-root", type=Path, default=None)
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--timeout", type=int, default=3600, help="per session, seconds")
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--auth-token", default=None)
    parser.add_argument("--promotion-metric", default="cost_usd")
    parser.add_argument("--promotion-min-runs", type=int, default=3)
    parser.add_argument("--promotion-min-improvement", type=float, default=5.0)
    parser.add_argument("--promotion-max-task-regression", type=float, default=20.0)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.generations < 1:
        parser.error("--generations must be positive")

    out_root = args.out_root or Path("results") / time.strftime("wfevolve-%Y%m%d-%H%M%S")
    out_root.mkdir(parents=True, exist_ok=True)
    evidence_dir: Path | None = args.seed_results

    for generation in range(args.generations):
        gen_dir = out_root / f"gen-{generation}"
        gen_dir.mkdir(parents=True, exist_ok=True)
        bench_dir = gen_dir / "bench"

        if generation == 0 and args.initial_overlay is not None:
            overlay_dir = args.initial_overlay.expanduser().resolve()
        else:
            overlay_dir = gen_dir / "overlay"
            overlay_dir.mkdir(parents=True, exist_ok=True)
            gate_summary: list[str] = []
            evidence: list[dict[str, Any]] = []
            if evidence_dir is not None:
                evidence = select_evidence(load_jsonl(evidence_dir / "results.jsonl"))
                promotion_path = evidence_dir / "promotion.json"
                if promotion_path.is_file():
                    gate_summary = summarize_gate(json.loads(promotion_path.read_text()))
            prompt = build_proposer_prompt(
                results_dir=evidence_dir.resolve() if evidence_dir else None,
                evidence=evidence,
                learnings=read_learnings(args.learnings),
                gate_summary=gate_summary,
                overlay_dir=overlay_dir.resolve(),
                proposal_path=(gen_dir / "proposal.md").resolve(),
                incumbent_arms=args.arms,
            )
            (gen_dir / "proposer-prompt.md").write_text(prompt)
            print(f"[gen {generation}] proposing…")
            record = run_proposer(prompt, args)
            (gen_dir / "proposer-session.json").write_text(json.dumps(record, indent=2) + "\n")
            if not record["ok"]:
                print(f"[gen {generation}] proposer session failed: {record['error_detail']}")
                return
            try:
                candidate_overlay_files(overlay_dir)
            except ValueError as exc:
                print(f"[gen {generation}] proposer produced an invalid overlay: {exc}")
                return

        print(f"[gen {generation}] benchmarking candidate…")
        bench = subprocess.run(runner_argv(args, bench_dir, overlay_dir), check=False)
        if bench.returncode != 0:
            print(f"[gen {generation}] benchmark run failed (exit {bench.returncode})")
            return
        promotion = json.loads((bench_dir / "promotion.json").read_text())
        for line in summarize_gate(promotion):
            print(f"[gen {generation}] {line}")

        promoted = promoted_decisions(promotion)
        if promoted:
            print(f"[gen {generation}] PROMOTED — evidence in {bench_dir}")
            if args.apply:
                written = apply_promoted_overlay(overlay_dir)
                print("applied to working tree:")
                for path in written:
                    print(f"  {path}")
                print(
                    "Next: review the diff, run "
                    "`cd gitnexus && npx vitest run test/unit/shipped-skills-sync.test.ts "
                    "test/unit/skills-steering.test.ts`, and open a PR citing "
                    f"{bench_dir}/promotion.json and {gen_dir / 'proposal.md'}."
                )
            else:
                print(
                    f"Re-run with --apply (or copy {overlay_dir} by hand) to stage the change for a human-reviewed PR."
                )
            return
        evidence_dir = bench_dir

    print(
        f"No candidate cleared the gate in {args.generations} generation(s); "
        f"trajectory evidence for the next attempt is in {out_root}/"
    )


if __name__ == "__main__":
    main()
