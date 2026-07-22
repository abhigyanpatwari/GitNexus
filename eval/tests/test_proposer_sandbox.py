"""Fail-closed containment contracts for proposer and candidate sessions."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from workflow_bench import runner

from workflow_bench.process_control import ManagedProcessResult, run_managed
from workflow_bench.proposer_sandbox import (
    MAX_BUNDLE_BYTES,
    MAX_EVIDENCE_FILE_BYTES,
    SANDBOX_NODE,
    SANDBOX_NODE_PREFIX,
    VITE_TEMP_DIR,
    SANDBOX_PATH,
    SANDBOX_PYTHON3,
    SANDBOX_SHELL_PREFIX,
    SANDBOX_USER_SKILLS,
    ReadOnlyMount,
    SandboxError,
    _runtime_mount_args,
    build_claude_settings,
    build_sandbox_environment,
    prepare_sandbox,
    preflight_bubblewrap,
    stage_evidence_bundle,
    stage_task_assets,
)
from workflow_bench.task_assets import TaskAssetCache, stage_task_assets as stage_immutable_task_assets


def test_environment_is_allowlisted_and_shell_children_are_credential_free(monkeypatch) -> None:
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "cloud-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-secret")
    monkeypatch.setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid")

    env = build_sandbox_environment(
        auth_token="model-secret",
        base_url="https://model.example.test/v1",
    )

    assert env["ANTHROPIC_API_KEY"] == "model-secret"
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["ANTHROPIC_BASE_URL"] == "https://model.example.test/v1"
    assert env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] == "1"
    assert env["CLAUDE_CODE_DONT_INHERIT_ENV"] == "1"
    assert env["CLAUDE_CODE_SHELL_PREFIX"] == SANDBOX_SHELL_PREFIX
    assert "model-secret" not in env["CLAUDE_CODE_SHELL_PREFIX"]
    assert not ({"AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "HTTPS_PROXY"} & env.keys())

    settings = json.loads(build_claude_settings())
    assert settings["sandbox"]["enabled"] is True
    assert settings["sandbox"]["failIfUnavailable"] is True
    assert settings["sandbox"]["allowUnsandboxedCommands"] is False
    assert settings["sandbox"]["network"]["deniedDomains"] == ["*"]
    # ENV_SCRUB forces "default" mode; the proposer's tools (Bash writes the
    # overlay) run headless only because they are explicitly pre-approved.
    # Requesting a non-default defaultMode would merely warn, so it must be gone.
    assert settings["permissions"]["allow"] == ["Read", "Grep", "Glob", "Bash"]
    assert "defaultMode" not in settings["permissions"]


@pytest.mark.parametrize(
    "bad_url",
    ["https://user:secret@example.test", "https://example.test/path?token=x", "file:///tmp/model"],
)
def test_environment_rejects_credential_bearing_or_non_http_endpoints(bad_url: str) -> None:
    with pytest.raises(SandboxError, match="base URL"):
        build_sandbox_environment(auth_token="token", base_url=bad_url)


def test_evidence_bundle_is_private_bounded_and_structured(tmp_path: Path) -> None:
    bundle = stage_evidence_bundle(
        tmp_path / "bundle",
        {
            "rows.json": [{"task": "t", "verify_tail": "ok"}],
            "gate.json": {"decision": "keep_incumbent"},
            "patch.diff": "diff --git a/a b/a\n",
        },
        secrets=["never-retain-me"],
    )

    assert stat.S_IMODE(bundle.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in bundle.iterdir())
    assert sum(path.stat().st_size for path in bundle.iterdir()) <= MAX_BUNDLE_BYTES
    assert "never-retain-me" not in "".join(path.read_text() for path in bundle.iterdir())


def test_evidence_bundle_rejects_paths_symlinks_special_files_and_limits(tmp_path: Path) -> None:
    with pytest.raises(SandboxError, match="simple relative"):
        stage_evidence_bundle(tmp_path / "traversal", {"../escape": "x"})
    with pytest.raises(SandboxError, match="per-file"):
        stage_evidence_bundle(
            tmp_path / "large",
            {"large.txt": "x" * (MAX_EVIDENCE_FILE_BYTES + 1)},
        )

    source = tmp_path / "source"
    source.write_text("ok")
    link = tmp_path / "link"
    link.symlink_to(source)
    with pytest.raises(SandboxError, match="regular non-symlink"):
        stage_evidence_bundle(tmp_path / "links", {"link.txt": link})


def test_evidence_bundle_rejects_aggregate_limit_and_removes_partial_bundle(tmp_path: Path) -> None:
    destination = tmp_path / "aggregate-overflow"
    entry_count = MAX_BUNDLE_BYTES // MAX_EVIDENCE_FILE_BYTES + 1
    entries = {f"part-{index}.txt": b"x" * MAX_EVIDENCE_FILE_BYTES for index in range(entry_count)}

    with pytest.raises(SandboxError, match="total byte limit"):
        stage_evidence_bundle(destination, entries)

    assert not destination.exists()


def test_sandbox_command_has_minimal_mounts_and_no_host_root_bind(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    clone.mkdir()
    claude = tmp_path / "claude"
    claude.write_text("#!/bin/sh\nexit 0\n")
    claude.chmod(0o755)
    bwrap = tmp_path / "bwrap"
    bwrap.write_text("#!/bin/sh\nexit 0\n")
    bwrap.chmod(0o755)

    with prepare_sandbox(
        clone=clone,
        claude_bin=claude,
        bwrap_bin=bwrap,
        preflight=False,
    ) as sandbox:
        argv = sandbox.command_prefix
        pairs = list(zip(argv, argv[1:]))
        assert "--unshare-pid" in argv
        assert "--unshare-ipc" in argv
        assert "--unshare-uts" in argv
        assert "--die-with-parent" in argv
        assert ("--ro-bind", "/") not in pairs
        assert str(clone.resolve()) in argv
        assert "/workspace" in argv
        assert sandbox.claude_bin == "/opt/claude/claude"
        assert sandbox.transcript_projects.parent.name == ".claude"
        shell_prefix_index = argv.index(SANDBOX_SHELL_PREFIX)
        assert argv[shell_prefix_index - 2] == "--ro-bind"
        shell_prefix = Path(argv[shell_prefix_index - 1])
        assert stat.S_IMODE(shell_prefix.stat().st_mode) == 0o500
        probe = subprocess.run(
            [
                shell_prefix,
                'test -z "${ANTHROPIC_API_KEY:-}" && test -z "${GITHUB_TOKEN:-}" && printf "%s" "$HOME|$PATH"',
            ],
            env={"ANTHROPIC_API_KEY": "model-secret", "GITHUB_TOKEN": "github-secret"},
            text=True,
            capture_output=True,
            check=False,
        )
        assert probe.returncode == 0, probe.stderr
        assert probe.stdout == f"/home/agent|{SANDBOX_PATH}"

        # The evidence-provenance.mjs plan-writer's PATH-scan trusts a Python 3
        # candidate only if it (and its directory) is owned by root or by the
        # current process — real /usr/bin/python3 is root-owned on the host,
        # which surfaces as the kernel's overflow uid inside this
        # --unshare-user sandbox (root itself is never mapped in). This wrapper
        # is freshly created by the host process instead, so it's trusted, and
        # it must still exec through to a real, working Python 3.
        python3_index = argv.index(SANDBOX_PYTHON3)
        assert argv[python3_index - 2] == "--ro-bind"
        python3_wrapper = Path(argv[python3_index - 1])
        assert stat.S_IMODE(python3_wrapper.stat().st_mode) == 0o500
        version = subprocess.run(
            [str(python3_wrapper), "-I", "-S", "-c", "import sys; print(sys.version_info[0])"],
            text=True,
            capture_output=True,
            check=False,
        )
        assert version.returncode == 0, version.stderr
        assert version.stdout.strip() == "3"

        assert SANDBOX_USER_SKILLS in argv
        user_skills_index = argv.index(SANDBOX_USER_SKILLS)
        assert argv[user_skills_index - 2] == "--ro-bind"
        private_root = sandbox.private_root
    assert not private_root.exists()


def test_runtime_mounts_bind_the_resolved_node_to_a_fresh_sandbox_path(monkeypatch) -> None:
    # sanitized_graph.py and runner_sessions.py invoke the sandboxed graph CLI
    # via SANDBOX_NODE. node's real host location varies (GitHub-hosted
    # runner images happen to have one under /usr/local/bin; a self-hosted
    # runner's actions/setup-node installs into its own tool-cache directory
    # instead), so this must bind to a FRESH sandbox path like /opt/claude/...
    # rather than anywhere under /usr, /bin, /lib, or /lib64: those are
    # already read-only bound by this same function, and bwrap can't create
    # a new mount-point file inside an already-read-only tree when the real
    # path doesn't already exist there on the host (observed empirically:
    # "bwrap: Can't create file at /usr/local/bin/node: Read-only file
    # system" when this bind first targeted that path on a self-hosted
    # runner where node isn't really there).
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: "/opt/hostedtoolcache/node/22.18.0/x64/bin/node" if name == "node" else None,
    )
    args = _runtime_mount_args()
    node_index = args.index("/opt/hostedtoolcache/node/22.18.0/x64/bin/node")
    assert args[node_index - 1] == "--ro-bind"
    assert args[node_index + 1] == SANDBOX_NODE
    assert not any(SANDBOX_NODE.startswith(bound + "/") for bound in ("/usr", "/bin", "/lib", "/lib64"))


def test_runtime_mounts_bind_the_node_prefix_so_npx_and_npm_resolve(monkeypatch, tmp_path) -> None:
    # npx and npm are not standalone binaries -- they are symlinks into
    # ../lib/node_modules/npm/bin/*-cli.js -- so binding the sibling files is
    # not enough; the install prefix carrying both bin/ and lib/node_modules
    # has to be mounted. Without this, a self-hosted runner (where
    # actions/setup-node installs into its own tool cache, outside /usr) gets
    # a sandbox with node but no npx, and every task verify command dies with
    # "/bin/sh: 1: npx: not found" -- all 18 runs of skill-evolution run
    # 29861768554 did exactly that.
    prefix = tmp_path / "hostedtoolcache" / "node" / "22.18.0" / "x64"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "bin" / "node").write_text("#!/bin/sh\nexit 0\n")
    (prefix / "lib" / "node_modules" / "npm" / "bin").mkdir(parents=True)
    (prefix / "lib" / "node_modules" / "npm" / "bin" / "npx-cli.js").write_text("")
    (prefix / "bin" / "npx").symlink_to("../lib/node_modules/npm/bin/npx-cli.js")
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(prefix / "bin" / "node") if name == "node" else None,
    )
    args = _runtime_mount_args()
    prefix_index = args.index(str(prefix))
    assert args[prefix_index - 1] == "--ro-bind"
    assert args[prefix_index + 1] == SANDBOX_NODE_PREFIX
    # the single-binary bind stays: sanitized_graph.py and runner_sessions.py
    # invoke SANDBOX_NODE directly.
    node_index = args.index(str(prefix / "bin" / "node"))
    assert args[node_index + 1] == SANDBOX_NODE
    # and the prefix's bin/ must actually be on PATH for npx to resolve.
    assert f"{SANDBOX_NODE_PREFIX}/bin" in SANDBOX_PATH.split(":")


def test_runtime_mounts_skip_the_prefix_bind_for_an_unrecognized_node_layout(monkeypatch, tmp_path) -> None:
    # The prefix is derived from the node binary's path, so it must only be
    # trusted when the layout really is <prefix>/bin/node carrying npm.
    # Otherwise parent.parent names an unrelated ancestor: /opt/bin/node would
    # bind ALL of /opt (every tool cache on a hosted runner) and a bare
    # <dir>/node would bind <dir>'s parent -- an over-broad mount into a
    # sandbox that runs untrusted model-authored code. The pre-existing
    # real-Bubblewrap node canary builds exactly this bare <dir>/node shape.
    bare = tmp_path / "toolcache"
    bare.mkdir()
    (bare / "node").write_text("#!/bin/sh\nexit 0\n")
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(bare / "node") if name == "node" else None,
    )
    args = _runtime_mount_args()
    assert SANDBOX_NODE_PREFIX not in args
    assert str(tmp_path) not in args
    # the node bind itself is unaffected -- SANDBOX_NODE still works.
    assert args[args.index(str(bare / "node")) + 1] == SANDBOX_NODE


def test_runtime_mounts_skip_the_prefix_bind_without_npx_beside_node(monkeypatch, tmp_path) -> None:
    # Right <prefix>/bin/node shape, but no working npx beside it: binding the
    # prefix would widen the mount surface without making npx resolvable.
    prefix = tmp_path / "x64"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "bin" / "node").write_text("#!/bin/sh\nexit 0\n")
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(prefix / "bin" / "node") if name == "node" else None,
    )
    args = _runtime_mount_args()
    assert SANDBOX_NODE_PREFIX not in args


def test_runtime_mounts_bind_a_real_tool_cache_layout(monkeypatch, tmp_path) -> None:
    # The positive counterpart: a genuine <prefix>/bin/node install carrying
    # npm, outside the system trees, is bound so npx resolves.
    prefix = tmp_path / "node" / "22.18.0" / "x64"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "bin" / "node").write_text("#!/bin/sh\nexit 0\n")
    (prefix / "lib" / "node_modules" / "npm" / "bin").mkdir(parents=True)
    (prefix / "lib" / "node_modules" / "npm" / "bin" / "npx-cli.js").write_text("")
    (prefix / "bin" / "npx").symlink_to("../lib/node_modules/npm/bin/npx-cli.js")
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(prefix / "bin" / "node") if name == "node" else None,
    )
    args = _runtime_mount_args()
    prefix_index = args.index(SANDBOX_NODE_PREFIX)
    assert args[prefix_index - 2] == "--ro-bind"
    assert args[prefix_index - 1] == str(prefix)


def test_runtime_mounts_skip_the_prefix_bind_when_it_is_already_bound(monkeypatch) -> None:
    # On an image where node genuinely lives in /usr/local/bin, the prefix is
    # /usr/local -- already inside the wholesale /usr read-only bind. Binding
    # it again would be redundant and would needlessly widen the argv, so the
    # containment surface stays minimal.
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: "/usr/local/bin/node" if name == "node" else None,
    )
    args = _runtime_mount_args()
    assert SANDBOX_NODE_PREFIX not in args
    assert args[args.index("/usr/local/bin/node") + 1] == SANDBOX_NODE


def test_runtime_mounts_skip_the_node_bind_when_node_is_unresolvable(monkeypatch) -> None:
    monkeypatch.setattr("workflow_bench.proposer_sandbox.shutil.which", lambda name: None)
    args = _runtime_mount_args()
    assert SANDBOX_NODE not in args


def test_node_modules_mounts_get_a_writable_vite_temp_overlay(tmp_path: Path) -> None:
    # vite writes <node_modules>/.vite-temp/<config>.timestamp-*.mjs before
    # loading a TypeScript config, so a read-only dependency mount makes vitest
    # fail with EROFS before any test runs -- and every task verify command and
    # every hidden oracle ends in "npx vitest run <test>". Reproduced on the
    # self-hosted runner with npx bypassed entirely, proving it is independent
    # of the node-prefix mount.
    clone = tmp_path / "clone"
    clone.mkdir()
    deps = tmp_path / "deps"
    deps.mkdir()
    # task_assets.py captures this directory into the dependency snapshot; the
    # overlay is gated on the mount source actually carrying it.
    (deps / VITE_TEMP_DIR).mkdir()
    executable = tmp_path / "executable"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o755)

    with prepare_sandbox(
        clone=clone,
        claude_bin=executable,
        bwrap_bin=executable,
        preflight=False,
        read_only_mounts=(ReadOnlyMount(source=deps, target="/workspace/gitnexus/node_modules"),),
    ) as sandbox:
        argv = sandbox.command_prefix

    bind_index = argv.index("/workspace/gitnexus/node_modules")
    assert argv[bind_index - 2 : bind_index + 1] == ["--ro-bind", str(deps), "/workspace/gitnexus/node_modules"]
    overlay = f"/workspace/gitnexus/node_modules/{VITE_TEMP_DIR}"
    overlay_index = argv.index(overlay)
    assert argv[overlay_index - 1] == "--tmpfs"
    # the overlay must come AFTER the read-only bind, or the bind would mask it
    assert overlay_index > bind_index


def test_node_modules_mount_without_a_captured_vite_temp_gets_no_overlay(tmp_path: Path) -> None:
    # The trusted GitNexus runtime mounts /opt/gitnexus/node_modules, whose
    # source is the built runtime and does NOT carry a .vite-temp. bwrap cannot
    # mkdir a mount point inside a read-only bind, so overlaying it would fail
    # with "Can't mkdir .../node_modules/.vite-temp: Read-only file system".
    # Regression for that CI failure: the overlay must fire only where the
    # source actually contains the directory, not for every node_modules mount.
    clone = tmp_path / "clone"
    clone.mkdir()
    runtime = tmp_path / "runtime-node-modules"
    runtime.mkdir()  # deliberately no .vite-temp
    executable = tmp_path / "executable"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o755)

    with prepare_sandbox(
        clone=clone,
        claude_bin=executable,
        bwrap_bin=executable,
        preflight=False,
        read_only_mounts=(ReadOnlyMount(source=runtime, target="/opt/gitnexus/node_modules"),),
    ) as sandbox:
        argv = sandbox.command_prefix

    assert "/opt/gitnexus/node_modules" in argv
    assert not any(str(item).endswith(f"/{VITE_TEMP_DIR}") for item in argv)


def test_non_node_modules_mounts_get_no_vite_temp_overlay(tmp_path: Path) -> None:
    # Scoped to dependency mounts: a hidden-oracle or skill mount stays wholly
    # read-only, with no writable island inside it.
    clone = tmp_path / "clone"
    clone.mkdir()
    other = tmp_path / "oracle"
    other.mkdir()
    executable = tmp_path / "executable"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o755)

    with prepare_sandbox(
        clone=clone,
        claude_bin=executable,
        bwrap_bin=executable,
        preflight=False,
        read_only_mounts=(ReadOnlyMount(source=other, target="/workspace/.wfbench-oracle-abc"),),
    ) as sandbox:
        argv = sandbox.command_prefix

    assert not any(str(item).endswith(f"/{VITE_TEMP_DIR}") for item in argv)


def test_stricter_prefix_freezes_evaluated_skills_and_can_unshare_network(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    skill = clone / ".claude" / "skills" / "gitnexus-work"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("trusted")
    executable = tmp_path / "executable"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o755)

    with prepare_sandbox(
        clone=clone,
        claude_bin=executable,
        bwrap_bin=executable,
        preflight=False,
    ) as sandbox:
        prefix = sandbox.command_prefix_for(
            read_only_paths=(skill,),
            unshare_network=True,
        )

    assert "--unshare-net" in prefix
    skill_target = "/workspace/.claude/skills/gitnexus-work"
    target_index = prefix.index(skill_target)
    assert prefix[target_index - 2 : target_index + 1] == ["--ro-bind", str(skill), skill_target]
    user_index = prefix.index(SANDBOX_USER_SKILLS)
    assert prefix[user_index - 2] == "--ro-bind"


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_runs_node_from_outside_the_bound_trees(tmp_path: Path, monkeypatch) -> None:
    # Reproduces the self-hosted-runner failure directly: node resolved from
    # a path outside /usr, /bin, /lib, /lib64 (actions/setup-node's own
    # tool-cache convention) must still be reachable inside the sandbox at
    # SANDBOX_NODE. A real node copied to a fresh, non-system location stands
    # in for the tool-cache install; argv-construction tests alone can't
    # catch a bwrap-level "Can't create file ...: Read-only file system"
    # (the actual error this fix resolves), only a real bwrap invocation can.
    real_node = shutil.which("node")
    if not real_node:
        pytest.skip("no node on PATH to relocate for this canary")
    toolcache = tmp_path / "toolcache"
    toolcache.mkdir()
    relocated_node = toolcache / "node"
    shutil.copy2(real_node, relocated_node)
    relocated_node.chmod(0o755)
    # Only fake "node"'s resolution -- prepare_sandbox's own bwrap/claude
    # lookups (_resolve_executable) also go through shutil.which, and must
    # keep resolving for real or preflight fails before the sandbox is even
    # built.
    real_which = shutil.which
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(relocated_node) if name == "node" else real_which(name),
    )

    clone = tmp_path / "clone"
    clone.mkdir()
    with prepare_sandbox(clone=clone, claude_bin=Path(sys.executable), preflight=True) as sandbox:
        result = sandbox.run([SANDBOX_NODE, "--version"], timeout=10)
    assert result.ok, result.stderr_tail


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_runs_npx_from_outside_the_bound_trees(tmp_path: Path, monkeypatch) -> None:
    # The npx half of the self-hosted-runner failure. Relocating a real node
    # INSTALL (bin/ + lib/node_modules, not just the binary) to a fresh path
    # outside /usr, /bin, /lib and /lib64 reproduces actions/setup-node's
    # tool-cache convention. Every task verify command is
    # "cd gitnexus && npx tsc ... && npx vitest ...", so npx must resolve
    # inside the sandbox; argv assertions cannot prove a bwrap-level mount
    # actually works, only a real invocation can.
    real_node = shutil.which("node")
    if not real_node:
        pytest.skip("no node on PATH to relocate for this canary")
    real_prefix = Path(real_node).resolve().parent.parent
    if not (real_prefix / "lib" / "node_modules" / "npm").is_dir():
        pytest.skip(f"node at {real_node} has no npm under its install prefix")
    toolcache = tmp_path / "toolcache" / "node" / "22.18.0" / "x64"
    shutil.copytree(real_prefix, toolcache, symlinks=True)
    relocated_node = toolcache / "bin" / "node"
    assert relocated_node.exists()
    real_which = shutil.which
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox.shutil.which",
        lambda name: str(relocated_node) if name == "node" else real_which(name),
    )

    clone = tmp_path / "clone"
    clone.mkdir()
    with prepare_sandbox(clone=clone, claude_bin=Path(sys.executable), preflight=True) as sandbox:
        result = sandbox.run(["/bin/sh", "-c", "command -v npx && npx --version"], timeout=60)
    assert result.ok, result.stderr_tail


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_blocks_repo_skill_edits_and_home_shadowing(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    skill = clone / ".claude" / "skills" / "gitnexus-work"
    skill.mkdir(parents=True)
    prompt = skill / "SKILL.md"
    prompt.write_text("trusted")

    script = """
from pathlib import Path
targets = [
    Path('/workspace/.claude/skills/gitnexus-work/SKILL.md'),
    Path('/home/agent/.claude/skills/gitnexus-work/SKILL.md'),
    Path('/opt/claude/shell-prefix'),
]
for target in targets:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('shadowed')
    except OSError:
        pass
    else:
        raise SystemExit(f'writable skill path: {target}')
Path('/workspace/unrelated-write').write_text('ok')
"""
    with prepare_sandbox(clone=clone, claude_bin=Path(sys.executable), preflight=True) as sandbox:
        result = run_managed(
            [*sandbox.command_prefix_for(read_only_paths=(skill,)), "/usr/bin/python3", "-c", script],
            timeout=10,
            env=sandbox.environment(),
            require_pid_namespace=True,
        )

    assert result.ok, result.stderr_tail
    assert prompt.read_text() == "trusted"
    assert (clone / "unrelated-write").read_text() == "ok"


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_verifier_cannot_rewrite_credited_source_or_oracle(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    clone.mkdir()
    implementation = clone / "implementation.py"
    implementation.write_text("trusted\n")
    oracle = tmp_path / "oracle"
    oracle.mkdir()
    hidden = oracle / "hidden.test"
    hidden.write_text("secret\n")
    oracle_mountpoint = clone / ".wfbench-oracle-canary"
    oracle_mountpoint.mkdir()

    script = """
import socket
from pathlib import Path
for target in (
    Path('/workspace/implementation.py'),
    Path('/workspace/oracle-leak.txt'),
    Path('/workspace/.wfbench-oracle-canary/hidden.test'),
):
    try:
        target.write_text('tampered')
    except OSError:
        pass
    else:
        raise SystemExit(f'writable verifier target: {target}')
Path('/tmp/verifier-scratch').write_text('ok')
probe = socket.socket()
probe.settimeout(0.2)
try:
    probe.connect(('1.1.1.1', 53))
except OSError:
    pass
else:
    raise SystemExit('verifier retained external network access')
finally:
    probe.close()
"""
    with prepare_sandbox(clone=clone, claude_bin=Path(sys.executable), preflight=True) as sandbox:
        prefix = sandbox.command_prefix_for(
            read_only_workspace=True,
            unshare_network=True,
            extra_read_only_mounts=(ReadOnlyMount(source=oracle, target="/workspace/.wfbench-oracle-canary"),),
        )
        assert "--unshare-net" in prefix
        result = run_managed(
            [*prefix, "/usr/bin/python3", "-c", script],
            timeout=10,
            env=sandbox.environment(),
            require_pid_namespace=True,
        )

    assert result.ok, result.stderr_tail
    assert implementation.read_text() == "trusted\n"
    assert hidden.read_text() == "secret\n"
    assert not (clone / "oracle-leak.txt").exists()


@pytest.mark.skipif(os.name == "nt", reason="symlink creation may require elevated Windows privileges")
@pytest.mark.parametrize("operation", ["stage", "sandbox"])
def test_clone_root_symlink_is_rejected_before_host_access(tmp_path: Path, operation: str) -> None:
    real_clone = tmp_path / "real-clone"
    real_clone.mkdir()
    linked_clone = tmp_path / "linked-clone"
    linked_clone.symlink_to(real_clone, target_is_directory=True)

    if operation == "stage":
        repo = tmp_path / "repo"
        repo.mkdir()
        source = repo / "asset"
        source.write_text("payload")
        with pytest.raises(SandboxError, match="real directory"):
            stage_task_assets(
                {"sandbox_copy": ["asset"]},
                repo=repo,
                clone=linked_clone,
            )
        assert not (real_clone / "asset").exists()
        return

    claude = tmp_path / "claude"
    claude.write_text("#!/bin/sh\nexit 0\n")
    claude.chmod(0o755)
    bwrap = tmp_path / "bwrap"
    bwrap.write_text("#!/bin/sh\nexit 0\n")
    bwrap.chmod(0o755)
    with pytest.raises(SandboxError, match="real directory"):
        with prepare_sandbox(
            clone=linked_clone,
            claude_bin=claude,
            bwrap_bin=bwrap,
            preflight=False,
        ):
            pytest.fail("a linked clone root must never enter the sandbox")


def test_preflight_failure_is_returned_before_a_model_command(monkeypatch, tmp_path: Path) -> None:
    bwrap = tmp_path / "bwrap"
    bwrap.write_text("#!/bin/sh\nexit 1\n")
    bwrap.chmod(0o755)
    calls: list[list[str]] = []
    runtime_mounts = ["--ro-bind", "/runtime", "/runtime"]

    def fail(command, **_kwargs):
        calls.append(list(command))
        return ManagedProcessResult(
            state="exited",
            returncode=1,
            stdout_tail="",
            stderr_tail="namespace denied",
            duration_s=0.1,
        )

    monkeypatch.setattr("workflow_bench.proposer_sandbox.run_managed", fail)
    monkeypatch.setattr(
        "workflow_bench.proposer_sandbox._runtime_mount_args",
        lambda: runtime_mounts,
    )
    with pytest.raises(SandboxError, match="preflight"):
        preflight_bubblewrap(bwrap)
    assert len(calls) == 1
    mount_index = calls[0].index("--new-session") + 1
    assert calls[0][mount_index : mount_index + len(runtime_mounts)] == runtime_mounts
    pairs = list(zip(calls[0], calls[0][1:]))
    assert ("--bind", "/") not in pairs
    assert ("--ro-bind", "/") not in pairs
    assert "claude" not in " ".join(calls[0])


def test_task_assets_are_copied_or_bound_without_symlink_escape(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    clone = tmp_path / "clone"
    (repo / ".gitnexus").mkdir(parents=True)
    clone.mkdir()
    source = repo / ".gitnexus" / "meta.json"
    source.write_text("{}")
    deps = repo / "node_modules"
    deps.mkdir()

    task = {
        "sandbox_copy": [".gitnexus/meta.json"],
        "sandbox_dependencies": [{"source": "node_modules", "target": "node_modules"}],
    }
    with TaskAssetCache(tmp_path / "asset-cache") as cache:
        snapshot = cache.prepare(task, repo=repo, resolved_sha="a" * 40)
        mounts = stage_immutable_task_assets(
            task,
            repo=repo,
            clone=clone,
            snapshot=snapshot,
        )

        copied = clone / ".gitnexus" / "meta.json"
        assert copied.read_text() == "{}"
        assert copied.stat().st_ino != source.stat().st_ino
        assert mounts[0].source != deps.resolve()
        assert mounts[0].target == "/workspace/node_modules"

        outside = tmp_path / "outside"
        outside.mkdir()
        (repo / "escape").symlink_to(outside, target_is_directory=True)
        with pytest.raises(SandboxError, match="symlink"):
            cache.prepare(
                {"sandbox_dependencies": [{"source": "escape", "target": "deps"}]},
                repo=repo,
                resolved_sha="a" * 40,
            )


@pytest.mark.skipif(os.name == "nt", reason="dirfd no-follow target canary is POSIX-only")
@pytest.mark.parametrize("kind", ["copy", "dependency"])
def test_task_asset_targets_never_follow_clone_symlink_parents(tmp_path: Path, kind: str) -> None:
    repo = tmp_path / "repo"
    clone = tmp_path / "clone"
    outside = tmp_path / "outside"
    repo.mkdir()
    clone.mkdir()
    outside.mkdir()
    (clone / "escape").symlink_to(outside, target_is_directory=True)

    if kind == "copy":
        (repo / "escape").mkdir()
        (repo / "escape" / "host-write").write_text("payload")
        task = {"sandbox_copy": ["escape/host-write"]}
    else:
        dependency = repo / "dependency"
        dependency.write_text("payload")
        task = {"sandbox_dependencies": [{"source": "dependency", "target": "escape/host-write"}]}

    with pytest.raises(SandboxError, match="symlink parent"):
        if kind == "copy":
            stage_task_assets(task, repo=repo, clone=clone)
        else:
            with TaskAssetCache(tmp_path / "asset-cache") as cache:
                snapshot = cache.prepare(task, repo=repo, resolved_sha="a" * 40)
                stage_immutable_task_assets(
                    task,
                    repo=repo,
                    clone=clone,
                    snapshot=snapshot,
                )
    assert not (outside / "host-write").exists()


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_real_bubblewrap_denies_parent_read_and_allows_clone_write(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    clone.mkdir()
    parent_secret = tmp_path / "parent-secret"
    parent_secret.write_text("secret")

    with prepare_sandbox(
        clone=clone,
        claude_bin=Path(sys.executable),
        preflight=True,
    ) as sandbox:
        result = sandbox.run(
            [
                "/usr/bin/python3",
                "-c",
                ("from pathlib import Path; assert not Path(%r).exists(); Path('/workspace/allowed').write_text('ok')")
                % str(parent_secret),
            ],
            timeout=10,
        )

    assert result.ok
    assert (clone / "allowed").read_text() == "ok"


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_BWRAP_CANARY") != "1",
    reason="real Bubblewrap canary is mandatory in the named Ubuntu CI job",
)
def test_clone_controlled_mcp_replacement_is_never_executed_or_credentialed(tmp_path: Path) -> None:
    clone = tmp_path / "clone"
    (clone / ".gitnexus").mkdir(parents=True)
    replacement = clone / ".gitnexus" / "run.cjs"
    replacement.write_text(
        "const fs=require('fs');"
        "let observed='no-key';"
        "for(const pid of fs.readdirSync('/proc')){"
        "try{const env=fs.readFileSync('/proc/'+pid+'/environ','utf8');"
        "if(env.includes('clone-mcp-canary-secret')) observed='credential-observed';}catch{}}"
        "fs.writeFileSync('/workspace/clone-mcp-ran', observed);"
    )

    trusted_runtime = tmp_path / "trusted-runtime"
    trusted_entrypoint = trusted_runtime / "dist" / "cli" / "index.js"
    trusted_entrypoint.parent.mkdir(parents=True)
    trusted_entrypoint.write_text(
        "process.stdout.write(process.env.ANTHROPIC_API_KEY ? 'credential-leaked' : 'credential-absent');"
    )
    mount = ReadOnlyMount(source=trusted_runtime, target=runner.SANDBOX_GITNEXUS)
    server = json.loads(runner.sandbox_mcp_config())["mcpServers"]["gitnexus"]

    with prepare_sandbox(
        clone=clone,
        claude_bin=Path(sys.executable),
        read_only_mounts=[mount],
        preflight=True,
    ) as sandbox:
        result = sandbox.run(
            [server["command"], *server["args"]],
            timeout=10,
            env=sandbox.environment(auth_token="clone-mcp-canary-secret"),
        )

    assert result.ok, result.stderr_tail
    assert result.stdout_tail == "credential-absent"
    assert not (clone / "clone-mcp-ran").exists()


@pytest.mark.skipif(
    os.environ.get("GITNEXUS_REQUIRE_CLAUDE_CANARY") != "1",
    reason="real Claude/Bash/MCP canary is mandatory in the named Ubuntu CI job",
)
def test_real_claude_bare_auth_inner_sandbox_and_mcp_permissions(tmp_path: Path) -> None:
    """Exercise the exact CLI boundary without contacting a paid model."""

    claude = Path(os.environ["CLAUDE_CANARY_BIN"]).resolve()
    assert claude.is_file()
    clone = tmp_path / "clone"
    clone.mkdir()
    fake_mcp = clone / "fake_mcp.py"
    fake_mcp.write_text(
        """import json
import sys
from pathlib import Path

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "notifications/initialized":
        continue
    if method == "initialize":
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "canary", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [{
                "name": "list_repos",
                "description": "record the permission canary",
                "inputSchema": {"type": "object", "properties": {}},
            }]
        }
    elif method == "tools/call":
        Path("/workspace/mcp-called").write_text("ok")
        result = {"content": [{"type": "text", "text": "repository list ready"}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}), flush=True)
"""
    )
    fake_mcp.chmod(0o500)

    observed_tool_results: dict[str, dict] = {}

    class ModelHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format, *_args):
            return

        def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler contract
            length = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(length))
            tool_result_ids = {
                block.get("tool_use_id")
                for message in request.get("messages", [])
                if isinstance(message, dict) and isinstance(message.get("content"), list)
                for block in message["content"]
                if isinstance(block, dict) and block.get("type") == "tool_result"
            }
            observed_tool_results.update(
                {
                    block["tool_use_id"]: block
                    for message in request.get("messages", [])
                    if isinstance(message, dict) and isinstance(message.get("content"), list)
                    for block in message["content"]
                    if isinstance(block, dict)
                    and block.get("type") == "tool_result"
                    and isinstance(block.get("tool_use_id"), str)
                }
            )
            if "toolu_mcp_canary" not in tool_result_ids:
                blocks = [
                    {
                        "type": "tool_use",
                        "id": "toolu_mcp_canary",
                        "name": "mcp__gitnexus__list_repos",
                        "input": {},
                    }
                ]
                stop_reason = "tool_use"
            elif "toolu_bash_canary" not in tool_result_ids:
                blocks = [
                    {
                        "type": "tool_use",
                        "id": "toolu_bash_canary",
                        "name": "Bash",
                        "input": {
                            "command": ('test -z "${ANTHROPIC_API_KEY:-}" && printf canary > /workspace/bash-called')
                        },
                    }
                ]
                stop_reason = "tool_use"
            else:
                blocks = [{"type": "text", "text": "canary complete"}]
                stop_reason = "end_turn"

            events = [
                (
                    "message_start",
                    {
                        "type": "message_start",
                        "message": {
                            "id": "msg_canary",
                            "type": "message",
                            "role": "assistant",
                            "model": request.get("model", "claude-canary"),
                            "content": [],
                            "stop_reason": None,
                            "stop_sequence": None,
                            "usage": {"input_tokens": 1, "output_tokens": 0},
                        },
                    },
                )
            ]
            for index, block in enumerate(blocks):
                if block["type"] == "text":
                    start = {"type": "text", "text": ""}
                    delta = {"type": "text_delta", "text": block["text"]}
                else:
                    start = {
                        "type": "tool_use",
                        "id": block["id"],
                        "name": block["name"],
                        "input": {},
                    }
                    delta = {
                        "type": "input_json_delta",
                        "partial_json": json.dumps(block["input"]),
                    }
                events.extend(
                    [
                        (
                            "content_block_start",
                            {"type": "content_block_start", "index": index, "content_block": start},
                        ),
                        (
                            "content_block_delta",
                            {"type": "content_block_delta", "index": index, "delta": delta},
                        ),
                        ("content_block_stop", {"type": "content_block_stop", "index": index}),
                    ]
                )
            events.extend(
                [
                    (
                        "message_delta",
                        {
                            "type": "message_delta",
                            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                            "usage": {"output_tokens": 1},
                        },
                    ),
                    ("message_stop", {"type": "message_stop"}),
                ]
            )
            payload = "".join(f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in events).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        mcp_config = json.dumps(
            {
                "mcpServers": {
                    "gitnexus": {
                        "type": "stdio",
                        "command": "/usr/bin/env",
                        "args": [
                            "-i",
                            "HOME=/home/agent",
                            "PATH=/usr/local/bin:/usr/bin:/bin",
                            "/usr/bin/python3",
                            "/workspace/fake_mcp.py",
                        ],
                    }
                }
            }
        )
        with prepare_sandbox(clone=clone, claude_bin=claude, preflight=True) as sandbox:
            result = sandbox.run(
                [
                    sandbox.claude_bin,
                    "-p",
                    "--input-format",
                    "text",
                    "--output-format",
                    "json",
                    "--bare",
                    "--settings",
                    sandbox.settings_json,
                    "--strict-mcp-config",
                    "--mcp-config",
                    mcp_config,
                    # No --permission-mode: mirrors production (run_proposer).
                    # ENV_SCRUB forces "default"; Bash runs only because
                    # settings permissions.allow pre-approves it. This is the
                    # authoritative empirical gate for that behavior.
                    "--model",
                    "claude-canary-20260718",
                    "--allowedTools",
                    "Bash",
                    "mcp__gitnexus__list_repos",
                ],
                timeout=60,
                env=sandbox.environment(
                    auth_token="offline-canary-key",
                    base_url=f"http://127.0.0.1:{server.server_port}",
                ),
                stdin_data=b"Use both available tools, then finish.",
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert result.ok, result.stderr_tail + result.stdout_tail
    report = json.loads(result.stdout_tail)
    assert report["subtype"] == "success" and report["is_error"] is False, report
    bash_result = observed_tool_results["toolu_bash_canary"]
    assert bash_result.get("is_error") is not True, bash_result
    assert (clone / "bash-called").read_text() == "canary"
    assert (clone / "mcp-called").read_text() == "ok"
