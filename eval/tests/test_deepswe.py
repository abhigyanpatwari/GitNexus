"""eval/deepswe: task preparation for the paired DeepSWE arms, and the paired report."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

from deepswe import prepare, report

DEEPSWE_DIR = Path(__file__).resolve().parents[1] / "deepswe"

# Trimmed from deep-swe@0b9fabbb tasks/abs-module-cache-flags/task.toml.
TASK_TOML = """schema_version = "1.3"
artifacts = ["/logs/artifacts/model.patch"]
[task]
name = "datacurve/abs-module-cache-flags"
description = ""
[metadata]
task_id = "abs-module-cache-flags"
language = "go"
base_commit_hash = "cb1b3b671d0ee9fa9da9f7b02f86967953ffd10a"
[verifier]
network_mode = "no-network"
environment_mode = "separate"
timeout_sec = 1800.0
[verifier.environment]
build_timeout_sec = 1800.0
docker_image = "verifier-image-stays"
[[verifier.collect]]
command = "cd /app && git diff --binary cb1b3b671d0ee9fa9da9f7b02f86967953ffd10a HEAD > /logs/artifacts/model.patch"
timeout_sec = 300.0
[agent]
network_mode = "no-network"
timeout_sec = 10800.0
[environment]
build_timeout_sec = 1800.0
docker_image = "public.ecr.aws/d3j8x8q7/swe-bench-202605:kh75679ajj3b8dtd7se3h7z0a1833y6r-v1.1"
os = "linux"
cpus = 2
memory_mb = 8192
mcp_servers = []
"""


def _task(root: Path, task_id: str, toml: str = TASK_TOML) -> Path:
    task = root / task_id
    (task / "environment").mkdir(parents=True)
    (task / "environment" / "Dockerfile").write_text("FROM upstream-build\n")
    (task / "tests").mkdir()
    (task / "tests" / "test.sh").write_text("#!/bin/bash\n")
    (task / "instruction.md").write_text("Implement the thing.\n")
    (task / "task.toml").write_text(toml.replace("abs-module-cache-flags", task_id))
    return task


def test_select_tasks_is_seeded_and_validates_ids():
    ids = [f"t{i:02d}" for i in range(20)]
    first = prepare.select_tasks(ids, include=None, n_tasks=5, seed=3)
    assert first == prepare.select_tasks(list(reversed(ids)), include=None, n_tasks=5, seed=3)
    assert len(first) == 5 and first == sorted(first)
    assert prepare.select_tasks(ids, include=None, n_tasks=None, seed=0) == ids
    assert prepare.select_tasks(ids, include=["t03", "t01", "t03"], n_tasks=5, seed=0) == ["t01", "t03"]
    with pytest.raises(SystemExit, match="nope"):
        prepare.select_tasks(ids, include=["nope"], n_tasks=None, seed=0)


def test_gitnexus_task_toml_builds_from_the_derived_dockerfile_under_a_new_name():
    data = tomllib.loads(prepare.gitnexus_task_toml(TASK_TOML))
    assert data["task"]["name"] == "datacurve/abs-module-cache-flags-gitnexus"
    assert "docker_image" not in data["environment"]
    assert data["environment"]["build_timeout_sec"] == prepare.MIN_BUILD_TIMEOUT_SEC
    # Everything else, including the separate verifier image and the patch collector, is untouched.
    original = tomllib.loads(TASK_TOML)
    assert data["verifier"] == original["verifier"]
    assert data["agent"] == original["agent"] and data["metadata"] == original["metadata"]
    assert {k: v for k, v in data["environment"].items() if k != "build_timeout_sec"} == {
        k: v for k, v in original["environment"].items() if k not in ("docker_image", "build_timeout_sec")
    }


def test_prepare_copies_baseline_unchanged_and_layers_gitnexus(tmp_path):
    tasks = tmp_path / "deep-swe" / "tasks"
    for task_id in ("alpha-task", "beta-task"):
        _task(tasks, task_id)
    package = tmp_path / "gitnexus-9.9.9.tgz"
    package.write_bytes(b"tarball")
    out = tmp_path / "out"

    assert prepare.main(["--deep-swe", str(tmp_path / "deep-swe"), "--out", str(out),
                         "--gitnexus-package", str(package), "--task", "alpha-task"]) == 0

    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["tasks"] == ["alpha-task"] and manifest["arms"] == ["baseline", "gitnexus"]
    assert not (out / "baseline" / "beta-task").exists()
    for name in ("task.toml", "instruction.md", "environment/Dockerfile", "tests/test.sh"):
        assert (out / "baseline" / "alpha-task" / name).read_bytes() == (tasks / "alpha-task" / name).read_bytes()

    derived = out / "gitnexus" / "alpha-task"
    dockerfile = (derived / "environment" / "Dockerfile").read_text()
    assert dockerfile.startswith(
        "FROM public.ecr.aws/d3j8x8q7/swe-bench-202605:kh75679ajj3b8dtd7se3h7z0a1833y6r-v1.1\n"
    )
    assert f"ARG NODE_VERSION={prepare.NODE_VERSION}" in dockerfile and "sha256sum -c -" in dockerfile
    assert "gitnexus analyze --index-only" in dockerfile and 'test "$before" = "$after"' in dockerfile
    # A task's own node/npm stay first on PATH; only a pinned wrapper is added.
    assert "ENV PATH" not in dockerfile and "/usr/local/bin/gitnexus" in dockerfile
    assert "{" not in dockerfile.replace("${", "")  # every template field was filled
    assert (derived / "environment" / prepare.PACKAGE_FILE).read_bytes() == b"tarball"
    instruction = (derived / "instruction.md").read_text()
    assert instruction.startswith("Implement the thing.\n") and instruction.endswith(prepare.GUIDANCE["product"])
    assert (derived / "tests" / "test.sh").read_bytes() == (tasks / "alpha-task" / "tests" / "test.sh").read_bytes()


def test_gitnexus_arm_requires_a_package_and_a_prebuilt_image(tmp_path):
    tasks = tmp_path / "deep-swe" / "tasks"
    _task(tasks, "gamma-task", TASK_TOML.replace('docker_image = "public.ecr', 'base_image = "public.ecr'))
    with pytest.raises(SystemExit):
        prepare.main(["--deep-swe", str(tmp_path / "deep-swe"), "--out", str(tmp_path / "o")])
    package = tmp_path / "p.tgz"
    package.write_bytes(b"x")
    with pytest.raises(ValueError, match="docker_image"):
        prepare.main(["--deep-swe", str(tmp_path / "deep-swe"), "--out", str(tmp_path / "o"),
                      "--gitnexus-package", str(package)])


@pytest.mark.parametrize("guidance", sorted(prepare.GUIDANCE))
def test_gitnexus_guidance_names_only_real_cli_commands(guidance):
    note = prepare.GUIDANCE[guidance]
    commands = set(re.findall(r"`gitnexus ([a-z-]+)", note)) - {"<command>"}
    assert commands == {"query", "context", "impact", "detect-changes"}
    assert len(note.encode()) < 1000


def test_prepare_records_the_guidance_variant(tmp_path):
    _task(tmp_path / "deep-swe" / "tasks", "delta-task")
    package = tmp_path / "p.tgz"
    package.write_bytes(b"x")
    prepare.main(["--deep-swe", str(tmp_path / "deep-swe"), "--out", str(tmp_path / "o"), "--arms", "gitnexus",
                  "--gitnexus-package", str(package), "--guidance", "optional"])
    assert json.loads((tmp_path / "o" / "manifest.json").read_text())["guidance"] == "optional"
    assert (tmp_path / "o" / "gitnexus" / "delta-task" / "instruction.md").read_text().endswith(
        prepare.GUIDANCE["optional"]
    )


def _trial(job: Path, name: str, task: str, *, reward=1, cost=1.0, steps=10, exception=None, commands=()):
    trial = job / name
    (trial / "agent").mkdir(parents=True)
    result = {
        "task_name": f"datacurve/{task}", "trial_name": name, "started_at": f"2026-10-30T00:00:{len(name):02d}Z",
        "agent_result": {"cost_usd": cost, "n_input_tokens": 1000, "n_cache_tokens": 800, "n_output_tokens": 50,
                         "n_agent_steps": steps},
        "verifier_result": None if reward is None else {"rewards": {"reward": reward}},
        "exception_info": exception,
        "agent_execution": {"started_at": "2026-10-30T00:00:00Z", "finished_at": "2026-10-30T00:01:40Z"},
    }
    (trial / "result.json").write_text(json.dumps(result))
    calls = [{"function_name": "bash", "arguments": {"command": command}} for command in commands]
    (trial / "agent" / "trajectory.json").write_text(json.dumps({"steps": [{"tool_calls": calls}]}))


def test_report_pairs_on_task_id_and_compares_matched_pairs_only(tmp_path):
    base, gitnexus = tmp_path / "baseline-job", tmp_path / "gitnexus-job"
    _trial(base, "a__1", "alpha", cost=1.0)
    _trial(base, "b__1", "beta", cost=9.0, reward=0)
    _trial(base, "c__1", "gamma", cost=2.0)
    _trial(gitnexus, "a__1", "alpha-gitnexus", cost=2.0,
           commands=["gitnexus query parse && gitnexus impact Foo", "ls gitnexus/ && cat gitnexus.json"])
    _trial(gitnexus, "b__1", "beta-gitnexus", cost=9.0, reward=-1)  # grader crash sentinel
    # gamma never ran in the gitnexus arm (interrupted sweep)
    _trial(base, "d__1", "delta", cost=3.0, reward=0, exception={"exception_type": "NonZeroAgentExitCodeError"})
    _trial(gitnexus, "d__1", "delta-gitnexus", cost=4.0, reward=1)
    (base / "config.json").write_text("{}")  # job-level files are not trials

    result = report.build_report({"baseline": base, "gitnexus": gitnexus})

    # The capped baseline trial (agent error, reward 0) is graded and paired, not dropped.
    assert result["pairs"] == {"graded_in_both": 2, "expected": 4}
    assert result["changes"]["cost_usd"] == {"percent": 50.0, "pairs": 2, "expected_pairs": 4}
    assert result["paired_resolved"] == {"baseline": 1, "gitnexus": 2}
    assert result["arms"]["baseline"]["resolved"] == 2 and result["arms"]["baseline"]["graded"] == 4
    assert result["arms"]["gitnexus"]["gitnexus_commands"] == {"query": 1, "impact": 1}
    assert result["arms"]["gitnexus"]["trials_using_gitnexus"] == 1
    assert any("gitnexus: 1 of 3 trial(s) ungraded" in problem for problem in result["problems"])
    assert any("2 of 4 task/attempt pair(s) graded in both arms" in problem for problem in result["problems"])
    assert any("baseline: 1 graded trial(s) ended with an agent error" in problem for problem in result["problems"])
    markdown = report.render_markdown(result)
    assert "gitnexus vs baseline: cost_usd: +50.0% (2/4 pairs, partial)" in markdown
    assert result["per_task"]["gamma#0"]["gitnexus"] is None


def test_report_marks_missing_billing_incomplete(tmp_path):
    base, gitnexus = tmp_path / "b", tmp_path / "g"
    for name, task in (("x__1", "x"), ("y__1", "y")):
        _trial(base, name, task, cost=1.0)
    _trial(gitnexus, "x__1", "x-gitnexus", cost=None)
    _trial(gitnexus, "y__1", "y-gitnexus", cost=3.0)

    result = report.build_report({"baseline": base, "gitnexus": gitnexus})

    assert result["arms"]["gitnexus"]["mean_cost_usd"] is None
    assert result["arms"]["gitnexus"]["incomplete_metrics"] == ["cost_usd"]
    assert result["changes"]["cost_usd"]["pairs"] == 1 and result["changes"]["n_agent_steps"]["pairs"] == 2
    assert "| gitnexus | 2/2 | incomplete |" in report.render_markdown(result)


def test_report_survives_an_arm_that_never_produced_a_job(tmp_path):
    _trial(tmp_path / "b", "x__1", "x")
    result = report.build_report({"baseline": tmp_path / "b", "gitnexus": tmp_path / "never-created"})
    assert any(problem.startswith("gitnexus: no trial results") for problem in result["problems"])
    assert result["pairs"] == {"graded_in_both": 0, "expected": 1} and result["changes"] == {}
    assert "| gitnexus | 0/0 |" in report.render_markdown(result)


def test_scripts_pin_the_same_versions_and_fill_every_bootstrap_placeholder():
    run_sh = (DEEPSWE_DIR / "run.sh").read_text()
    bootstrap = (DEEPSWE_DIR / "ec2" / "bootstrap.sh").read_text()
    launch = (DEEPSWE_DIR / "ec2" / "launch.sh").read_text()

    def pin(text: str, name: str) -> str:
        match = re.search(rf"^{name}=(\S+)", text, re.MULTILINE)
        assert match, name
        return match.group(1)

    assert pin(run_sh, "PIER_VERSION") == pin(bootstrap, "PIER_VERSION")
    # The gateway and the optional mini-swe-agent use the versions eval/ is locked to.
    lock = (DEEPSWE_DIR.parent / "uv.lock").read_text()
    for package, name in (("litellm", "LITELLM_VERSION"), ("mini-swe-agent", "MINI_SWE_AGENT_VERSION")):
        assert f'name = "{package}"\nversion = "{pin(run_sh, name)}"' in lock, package
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin(run_sh, "CLAUDE_CODE_VERSION"))
    assert pin(bootstrap, "NODE_VERSION") == prepare.NODE_VERSION
    assert re.fullmatch(r"[0-9a-f]{40}", pin(run_sh, "DEEP_SWE_COMMIT"))
    placeholders = set(re.findall(r"@([A-Z_]+)@", bootstrap))
    assert placeholders == set(re.findall(r"s\|@([A-Z_]+)@\|", launch)) == {"GITNEXUS_REPO", "GITNEXUS_REF", "MAX_HOURS"}
    assert "API_KEY" not in bootstrap.replace("# No model key", "")
