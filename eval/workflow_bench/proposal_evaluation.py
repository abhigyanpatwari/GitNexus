"""Paired, stock-Linux patch proposals with measured CLI usage and offline grading."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections.abc import Sequence
from contextlib import ExitStack
from dataclasses import dataclass, replace
from pathlib import Path

from . import release_report
from .mock_provider import MockProvider, Reply
from .oci_worker import WORKER_IMAGE, run_worker, worker_command
from .oracle_assets import (
    ORACLE_ENV_VAR,
    ORACLE_ROOT,
    TaskOracleSnapshot,
    capture_task_oracle,
    sanitize_clone_for_hidden_oracles,
    staged_task_oracle,
)
from .process_control import ManagedProcessError, cancellation_scope, run_checked
from .proposer_sandbox import (
    ReadOnlyMount,
    SandboxError,
    baseline_gitnexus_mounts,
    build_claude_settings,
    build_sandbox_environment,
)
from .proposal_tools import TOOLS
from .release_controls import REFERENCES
from .runner import isolated_gitnexus_registry_mount
from .runner_artifacts import VerificationResult, copy_isolated_tree, make_worktree
from .runner_sessions import GITNEXUS_MUTATING_TOOLS, GITNEXUS_READ_ONLY_TOOLS, run_claude
from .runner_tasks import normalized_model_identifier
from .runtime_mounts import trusted_gitnexus_runtime_mounts
from .sanitized_graph import SANDBOX_GITNEXUS_ENTRYPOINT, prepare_sanitized_graph
from .task_assets import TaskAssetCache, TaskAssetSnapshot, stage_task_assets
from .verification_diagnostics import verification_metrics


# A full typecheck of the pinned repository can exceed five minutes on small hosts.
GRADING_TIMEOUT_S = 15 * 60


@dataclass(frozen=True)
class ModelClient:
    binary: Path
    model: str
    effort: str
    api_key: str
    base_url: str | None = None
    timeout: int = 1800
    max_budget_usd: float | None = None


@dataclass(frozen=True)
class Source:
    checkout: Path
    indexed: Path
    runtime: Sequence[ReadOnlyMount]


@dataclass(frozen=True)
class PreparedTask:
    task: dict
    repo: Path
    source: Source
    oracle: TaskOracleSnapshot
    assets: TaskAssetSnapshot


def _mcp_server(command: Sequence[str]) -> dict:
    # The CLI can launch exactly this server. Its Docker client and worker
    # receive no model credential, user configuration, or inherited environment.
    return {"type": "stdio", "command": "/usr/bin/env", "args": ["-i", "PATH=/usr/bin:/bin", *command]}


def _probe_servers(source: Source, client: ModelClient, parent: Path) -> None:
    for augmented in (False, True):
        tools = [{"name": "mcp__checkout__submit_patch", "input": {"patch": "offline probe"}}]
        if augmented:
            tools.append({"name": "mcp__gitnexus__list_repos", "input": {}})
        with tempfile.TemporaryDirectory(dir=parent) as directory, MockProvider([Reply(tools=tools)]) as provider:
            root = Path(directory)
            proposal = root / "proposal"
            proposal.mkdir()
            offline = replace(
                client,
                model="claude-sonnet-4-6",
                api_key="offline-preflight",
                base_url=provider.base_url,
                timeout=120,
                max_budget_usd=None,
            )
            result = propose(
                "Check the workspace tools.",
                source=source.checkout,
                graph_repo=source.indexed,
                runtime=source.runtime,
                proposal=proposal,
                client=offline,
                augmented=augmented,
                out=root,
                label="offline-preflight",
            )
            outputs = {
                block.get("tool_use_id"): block
                for request in provider.requests
                for msg in request.body.get("messages", [])
                if msg.get("role") == "user" and isinstance(msg.get("content"), list)
                for block in msg["content"]
                if block.get("type") == "tool_result" and not block.get("is_error")
            }
            patch = proposal / "change.patch"
            names = (
                {tool["name"] for tool in provider.requests[0].body.get("tools", [])} if provider.requests else set()
            )
            checkout_tools = {f"mcp__checkout__{name}" for name in TOOLS}
            permitted = checkout_tools | (set(GITNEXUS_READ_ONLY_TOOLS) if augmented else set())
            required = checkout_tools | ({"mcp__gitnexus__list_repos"} if augmented else set())
            arm = "with GitNexus" if augmented else "without GitNexus"
            if not result.get("ok"):
                detail = result.get("error_detail")
                kind = result.get("error_kind")
                err_msg = ""
                if isinstance(detail, dict):
                    err = (
                        detail.get("event_stream_error")
                        or detail.get("stderr_tail")
                        or detail.get("stdout_tail")
                        or detail.get("process_detail")
                    )
                    rc = detail.get("returncode")
                    subtype = detail.get("subtype")
                    state = detail.get("process_state")
                    if rc is not None and rc != 0:
                        err_msg = f": exit code {rc} ({err})" if err else f": exit code {rc}"
                    elif subtype:
                        err_msg = f": {subtype} ({err})" if err else f": {subtype}"
                    elif state and state not in ("ok", "completed"):
                        err_msg = f": {state} ({err})" if err else f": {state}"
                    elif err:
                        err_msg = f": {err}"
                elif detail:
                    err_msg = f": {detail}"
                elif kind:
                    err_msg = f": {kind}"
                raise SandboxError(f"offline CLI preflight {arm} session failed{err_msg}")

            missing_tools = required - names
            if missing_tools:
                raise SandboxError(
                    f"offline CLI preflight {arm} missing required tool(s): {', '.join(sorted(missing_tools))}"
                )

            unpermitted_tools = names - permitted
            if unpermitted_tools:
                raise SandboxError(
                    f"offline CLI preflight {arm} declared unpermitted tool(s): {', '.join(sorted(unpermitted_tools))}"
                )

            if len(outputs) != len(tools):
                raise SandboxError(
                    f"offline CLI preflight {arm} failed: {len(outputs)}/{len(tools)} successful tool results"
                )

            if not patch.is_file():
                raise SandboxError(f"offline CLI preflight {arm} did not produce change.patch")

            if patch.read_bytes() != b"offline probe":
                raise SandboxError(f"offline CLI preflight {arm} change.patch content mismatch")

            if augmented and "benchmark-target" not in str(outputs.get("toolu_mock_1", {}).get("content")):
                raise SandboxError(
                    f"offline CLI preflight {arm} list_repos output missing expected 'benchmark-target'"
                )


def propose(
    prompt: str,
    *,
    source: Path,
    graph_repo: Path,
    runtime: Sequence[ReadOnlyMount],
    proposal: Path,
    client: ModelClient,
    augmented: bool,
    out: Path,
    label: str,
) -> dict:
    with ExitStack() as stack:
        home = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="gnx-client-")))
        client_env = build_sandbox_environment(auth_token=client.api_key, base_url=client.base_url)
        env = {key: value for key, value in client_env.items() if key.startswith("ANTHROPIC_")}
        env.update(
            HOME=str(home),
            CLAUDE_CONFIG_DIR=str(home / ".claude"),
            PATH="/usr/bin:/bin",
            LANG="C.UTF-8",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
            DISABLE_AUTOUPDATER="1",
            ENABLE_TOOL_SEARCH="false",
            MCP_CONNECTION_NONBLOCKING="0",
            MCP_CONNECT_TIMEOUT_MS="90000",
            MCP_TIMEOUT="90000",
        )
        masks = baseline_gitnexus_mounts(source, home)
        workspace = stack.enter_context(
            worker_command(
                checkout=source,
                readonly=True,
                interactive=True,
                mounts=[*masks, ReadOnlyMount(Path(__file__).with_name("proposal_tools.py"), "/run/gnx-tools.py")],
                writable_mounts=[ReadOnlyMount(proposal, "/proposal")],
            )
        )
        servers = {"checkout": _mcp_server([*workspace, "/usr/bin/python3", "-I", "/run/gnx-tools.py"])}
        allowed = [f"mcp__checkout__{name}" for name in TOOLS]
        if augmented:
            graph = stack.enter_context(
                worker_command(
                    checkout=graph_repo,
                    readonly=True,
                    interactive=True,
                    mounts=runtime,
                    environment={
                        "GITNEXUS_HOME": "/opt/gitnexus-registry",
                        "GITNEXUS_MCP_ALLOWED_REPOS": "/workspace",
                        "GITNEXUS_MCP_DEFAULT_REPO": "/workspace",
                        "GITNEXUS_MCP_READ_ONLY": "1",
                    },
                )
            )
            servers["gitnexus"] = _mcp_server([*graph, "/usr/local/bin/node", SANDBOX_GITNEXUS_ENTRYPOINT, "mcp"])
            allowed.extend(GITNEXUS_READ_ONLY_TOOLS)
        settings = json.loads(build_claude_settings())
        denied = ["Bash", *GITNEXUS_MUTATING_TOOLS]
        settings["permissions"] = {"allow": allowed, "deny": denied, "disableBypassPermissionsMode": "disable"}
        return run_claude(
            prompt + "\n\nInspect the frozen checkout and submit your complete unified Git diff with "
            "the workspace submit_patch tool. The evaluator applies the last submission and runs the checks.",
            home,
            claude_bin=str(client.binary),
            timeout=client.timeout,
            model=client.model,
            effort=client.effort,
            env=env,
            permission_mode="dontAsk",
            settings_json=json.dumps(settings),
            strict_mcp_config=True,
            mcp_config_json=json.dumps({"mcpServers": servers}),
            allowed_tools=allowed,
            disallowed_tools=denied,
            disable_slash_commands=True,
            isolated_client_config=True,
            required_mcp_servers=tuple(servers),
            transcript_output_dir=out,
            transcript_output_prefix=label,
            transcript_secrets=(client.api_key,),
            max_budget_usd=client.max_budget_usd,
        )


def _checked_exit(command: list[str], **kwargs):
    result = run_worker(command, check=False, **kwargs)
    if result.returncode in (125, 126, 127, 137):
        raise SandboxError(f"evaluation worker failed: {result.state}, exit={result.returncode}")
    return result


def grade(
    task: dict,
    oracle: TaskOracleSnapshot,
    *,
    source: Path,
    repo: Path,
    assets: TaskAssetSnapshot,
    patch: Path | None,
    parent: Path,
    public_check: str | None = None,
) -> tuple[bool, bool, bool, dict]:
    with tempfile.TemporaryDirectory(prefix="gnx-grade-", dir=parent) as temp:
        root = Path(temp)
        clone = copy_isolated_tree(source, root)
        mounts = stage_task_assets(task, repo=repo, clone=clone, snapshot=assets)
        mounts.append(ReadOnlyMount(clone / ".git", "/workspace/.git"))
        applied = False
        if patch is not None:
            result = _checked_exit(
                ["/usr/bin/git", "apply", "--whitespace=nowarn", "/run/submission.patch"],
                checkout=clone,
                readonly=False,
                mounts=[*mounts, ReadOnlyMount(patch, "/run/submission.patch")],
                timeout=60,
            )
            applied = result.ok
        verified = (
            applied
            and _checked_exit(
                ["/bin/sh", "-c", public_check or task["verify"]],
                checkout=clone,
                readonly=True,
                mounts=mounts,
                timeout=GRADING_TIMEOUT_S,
            ).ok
        )
        with staged_task_oracle(root, oracle) as hidden:
            target = "/workspace/" + hidden.name
            (clone / hidden.name).mkdir(mode=0o700)
            result = _checked_exit(
                ["/bin/sh", "-c", oracle.command],
                checkout=clone,
                readonly=True,
                mounts=[*mounts, ReadOnlyMount(hidden, target)],
                environment={ORACLE_ENV_VAR: target},
                timeout=GRADING_TIMEOUT_S,
            )
            evidence = VerificationResult(oracle.command, result, result.stdout_tail + result.stderr_tail)
            diagnostics = verification_metrics(evidence, result.duration_s)
        return applied, verified, result.ok, diagnostics


def check_grader(
    task: dict,
    oracle: TaskOracleSnapshot,
    *,
    source: Path,
    repo: Path,
    assets: TaskAssetSnapshot,
    reference: Path,
    parent: Path,
) -> None:
    _, _, base_passes, negative = grade(
        task, oracle, source=source, repo=repo, assets=assets, patch=None, parent=parent
    )
    if (
        base_passes
        or negative["exit_code"] != 1
        or not negative["assertion_failure"]
        or negative["startup_failure"]
        or negative["permission_failure"]
    ):
        raise SandboxError(f"{task['id']}: the base checkout did not fail a behavioral assertion")
    typecheck = "cd gitnexus && ./node_modules/.bin/tsc --noEmit" if task["id"] in REFERENCES else task["verify"]
    applied, typed, passed, _ = grade(
        task, oracle, source=source, repo=repo, assets=assets, patch=reference, parent=parent, public_check=typecheck
    )
    if not (applied and typed and passed):
        raise SandboxError(
            f"{task['id']}: reference control failed (applied={applied}, typechecked={typed}, oracle={passed})"
        )


def _prepare_tasks(
    tasks: list[dict],
    metadata: dict,
    runtime: Sequence[ReadOnlyMount],
    client: ModelClient,
    root: Path,
    cache: TaskAssetCache,
    oracle_root: Path,
    reference_dir: Path,
) -> list[PreparedTask]:
    sources: dict[tuple[Path, str], Source] = {}
    prepared = []
    for task in tasks:
        repo, sha = Path(task["repo"]).expanduser().resolve(), task["ref"]
        oracle = capture_task_oracle(task, root=oracle_root)
        if metadata["tasks"].get(task["id"]) != {"sha": sha, "oracle_digest": oracle.digest} or task.get("setup"):
            raise ValueError("proposal task does not match the pinned release corpus")
        if (repo, sha) not in sources:
            checkout = make_worktree(repo, sha, root)
            head = sanitize_clone_for_hidden_oracles(checkout)
            graph = prepare_sanitized_graph(
                task,
                repo=repo,
                resolved_sha=sha,
                parent=root,
                cache=cache,
                claude_bin=client.binary,
                bwrap_bin=None,
                runtime_mounts=runtime,
                sandbox_backend="docker",
                clone_template=checkout,
                sanitized_head=head,
            )
            indexed = copy_isolated_tree(checkout, root)
            graph.materialize(indexed, sanitized_head=head)
            source = Source(checkout, indexed, [*runtime, isolated_gitnexus_registry_mount(indexed, root)])
            _probe_servers(source, client, root)
            sources[repo, sha] = source
        source = sources[repo, sha]
        assets = cache.prepare(task, repo=repo, resolved_sha=sha)
        reference = reference_dir / (REFERENCES.get(task["id"], task["id"]) + ".patch")
        check_grader(task, oracle, source=source.checkout, repo=repo, assets=assets, reference=reference, parent=root)
        prepared.append(PreparedTask(task, repo, source, oracle, assets))
    return prepared


def _measure(
    prepared: PreparedTask,
    *,
    arm: str,
    run: int,
    client: ModelClient,
    out: Path,
    parent: Path,
    metadata: dict,
    version: str,
) -> dict:
    task = prepared.task
    augmented = arm == "baseline"
    with tempfile.TemporaryDirectory(prefix="proposal-", dir=parent) as directory:
        proposal = Path(directory)
        session = propose(
            task["prompt"],
            source=prepared.source.checkout,
            graph_repo=prepared.source.indexed,
            runtime=prepared.source.runtime,
            proposal=proposal,
            client=client,
            augmented=augmented,
            out=out,
            label=f"{task['id']}-{run}-{arm}",
        )
        applied = authored = hidden = False
        if session["ok"] and session["cost_usd"] is None:
            session.update(ok=False, error_kind="usage-missing")
        if session["ok"]:
            patch = proposal / "change.patch"
            try:
                applied, authored, hidden, _ = grade(
                    task,
                    prepared.oracle,
                    source=prepared.source.checkout,
                    repo=prepared.repo,
                    assets=prepared.assets,
                    patch=patch if patch.is_file() else None,
                    parent=parent,
                )
            except (ManagedProcessError, SandboxError, OSError):
                # Preserve the completed model's usage and stop the sweep if its grader failed to run.
                session.update(ok=False, error_kind="grading-infrastructure")
    authored = applied and authored
    error = session["error_kind"]
    if error is None and not authored:
        error = "verify-failed"
    elif error is None and not hidden:
        error = "oracle-failed"
    session.pop("error_detail", None)
    return {
        **session,
        **prepared.assets.dependency_binding,
        "task": task["id"],
        "task_base_sha": task["ref"],
        "oracle_digest": prepared.oracle.digest,
        "model": client.model,
        "effort": client.effort,
        "run": run,
        "arm": arm,
        "runtime_sha": metadata["runtime_sha"],
        "harness_sha": metadata["harness_sha"],
        "sandbox_backend": "docker",
        "executor": release_report.PROPOSAL_EXECUTOR,
        "worker_image": WORKER_IMAGE,
        "claude_version": version,
        "usage_source": metadata["usage_source"],
        "runtime_exposure": "stdio-only" if augmented else "none",
        "proposal_applied": applied,
        "authored_tests_passed": authored,
        "oracle_passed": hidden,
        "resolved": authored and hidden,
        "error_kind": error,
    }


def evaluate(
    tasks: list[dict],
    metadata: dict,
    *,
    runtime_root: Path,
    client: ModelClient,
    out: Path,
    oracle_root: Path = ORACLE_ROOT,
    reference_dir: Path | None = None,
) -> dict:
    """Validate all toolsets and grading controls before opening any measured model session."""
    if metadata["runs"] < 3 or client.model != metadata["model"] or client.effort != metadata["effort"]:
        raise ValueError("the paired evaluator requires the prepared model, effort and at least three runs")
    if sorted(t["id"] for t in tasks) != sorted(metadata["tasks"]):
        raise ValueError("the prepared task IDs differ from the selected corpus")
    metadata = {
        **metadata,
        "executor": release_report.PROPOSAL_EXECUTOR,
        "usage_source": "fixture" if client.base_url else "anthropic",
    }
    version = run_checked(
        [str(client.binary), "--version"], timeout=30, env={"PATH": "/usr/bin:/bin"}
    ).stdout_tail.strip()
    if version != release_report.PROPOSAL_CLIENT:
        raise ValueError(f"the proposal evaluator requires {release_report.PROPOSAL_CLIENT}")
    runtime = trusted_gitnexus_runtime_mounts(root=runtime_root)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    rows = []
    with (
        tempfile.TemporaryDirectory(prefix="gnx-paired-") as directory,
        TaskAssetCache(Path(directory) / "assets") as cache,
    ):
        root = Path(directory)
        prepared = _prepare_tasks(
            tasks, metadata, runtime, client, root, cache, oracle_root, reference_dir or oracle_root / "reference"
        )
        with (out / "results.jsonl").open("x", encoding="utf-8") as raw:
            cells = (
                (task, run, arm)
                for task in prepared
                for run in range(metadata["runs"])
                for arm in (release_report.ARMS if run % 2 == 0 else reversed(release_report.ARMS))
            )
            for task, run, arm in cells:
                row = _measure(
                    task, arm=arm, run=run, client=client, out=out, parent=root, metadata=metadata, version=version
                )
                raw.write(json.dumps(row, allow_nan=False) + "\n")
                raw.flush()
                rows.append(row)
                if not row["ok"]:
                    break
    report = release_report.build_report(rows, metadata)
    if report["complete"]:
        release_report.validate_report(
            report,
            runtime_sha=metadata["runtime_sha"],
            task_set_digest=metadata["task_set_digest"],
            task_pins=metadata["tasks"],
            expected_schema=release_report.PROPOSAL_SCHEMA,
            expected_usage_source=metadata["usage_source"],
        )
    (out / "proposal-evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    (out / "proposal-evaluation.md").write_text(release_report.render_markdown(report))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--task-repo", required=True, type=Path)
    parser.add_argument("--claude-bin", required=True, type=Path)
    parser.add_argument("--model", required=True, type=normalized_model_identifier)
    parser.add_argument("--effort", choices=("low", "medium", "high"), default="high")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--max-budget-usd", type=float)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if not args.model.startswith("claude-"):
        parser.error("select a named Claude model for direct Anthropic usage accounting")
    tasks, digest, pins = release_report.suite_binding()
    if release_report._git_sha(args.task_repo) != release_report.pinned_task_sha(tasks):
        parser.error("the built task checkout must match the pinned corpus")
    for task in tasks:
        task["repo"] = str(args.task_repo.resolve())
    key = os.environ.get("GITNEXUS_BENCH_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        parser.error("provide GITNEXUS_BENCH_ANTHROPIC_API_KEY for the selected model endpoint")
    metadata = dict(
        runtime_sha=release_report._git_sha(args.runtime),
        harness_sha=release_report._git_sha(Path(__file__).resolve().parents[2]),
        task_set_digest=digest,
        model=args.model,
        effort=args.effort,
        runs=args.runs,
        tasks=pins,
    )
    client = ModelClient(
        args.claude_bin.resolve(strict=True),
        args.model,
        args.effort,
        key,
        max_budget_usd=args.max_budget_usd,
    )
    try:
        with cancellation_scope(handle_signals=True):
            report = evaluate(tasks, metadata, runtime_root=args.runtime, client=client, out=args.out)
            if report["complete"]:
                return
    except (SandboxError, ManagedProcessError, ValueError, OSError) as exc:
        parser.error(str(exc))
    raise SystemExit(1)


if __name__ == "__main__":
    main()
