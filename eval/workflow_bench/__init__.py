"""Benchmark the gitnexus-plan / gitnexus-work engineering workflow.

Runs real headless Claude Code sessions (``claude -p --output-format json``)
in throwaway git worktrees, one arm using the skill workflow and one baseline
arm without it, and reports per-arm token usage, cost, wall time, and task
resolution so the workflow's token savings are observable rather than assumed.
"""
