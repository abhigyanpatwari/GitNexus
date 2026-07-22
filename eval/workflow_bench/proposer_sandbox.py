"""Linux containment and evidence staging for workflow-bench model sessions."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from .process_control import ManagedProcessResult, run_managed


MAX_EVIDENCE_FILE_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = 2 * 1024 * 1024
SANDBOX_WORKSPACE = "/workspace"
SANDBOX_HOME = "/home/agent"
SANDBOX_TMP = "/tmp"
SANDBOX_CLAUDE = "/opt/claude/claude"
SANDBOX_SHELL_PREFIX = "/opt/claude/shell-prefix"
SANDBOX_PYTHON3 = "/opt/claude/python3"
SANDBOX_NODE = "/opt/claude/node"
SANDBOX_NODE_PREFIX = "/opt/claude/nodejs"
# Vite transpiles a TypeScript config into <node_modules>/.vite-temp before it
# loads anything, so a read-only dependency mount makes `vitest` die with EROFS
# before a single test runs -- and every task verify command and every hidden
# oracle ends in `npx vitest run <test>`. bwrap cannot create a mount point
# inside an already-read-only bind, so the directory is captured into the
# dependency snapshot (task_assets.py) and a tmpfs is overlaid on it here.
VITE_TEMP_DIR = ".vite-temp"
DEPENDENCY_MOUNT_BASENAME = "node_modules"
SANDBOX_PATH = f"/opt/claude:{SANDBOX_NODE_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin"
SANDBOX_GITNEXUS = "/opt/gitnexus"
SANDBOX_GITNEXUS_SHARED = "/opt/gitnexus-shared"
SANDBOX_GITNEXUS_REGISTRY = "/opt/gitnexus-registry"
SANDBOX_USER_SKILLS = f"{SANDBOX_HOME}/.claude/skills"


class SandboxError(RuntimeError):
    """Containment could not be established without weakening the contract."""


@dataclass(frozen=True)
class ReadOnlyMount:
    source: Path
    target: str


@dataclass(frozen=True)
class SandboxSession:
    private_root: Path
    clone: Path
    home: Path
    temp: Path
    bwrap_bin: Path
    claude_host_bin: Path
    command_prefix: list[str]
    read_only_mounts: tuple[ReadOnlyMount, ...]

    @property
    def claude_bin(self) -> str:
        return SANDBOX_CLAUDE

    @property
    def transcript_projects(self) -> Path:
        return self.home / ".claude" / "projects"

    @property
    def settings_json(self) -> str:
        return build_claude_settings()

    def environment(
        self,
        *,
        auth_token: str | None = None,
        base_url: str | None = None,
    ) -> dict[str, str]:
        return build_sandbox_environment(auth_token=auth_token, base_url=base_url)

    def run(
        self,
        command: Sequence[str],
        *,
        timeout: float,
        env: Mapping[str, str] | None = None,
        stdin_data: bytes | None = None,
    ) -> ManagedProcessResult:
        return run_managed(
            [*self.command_prefix, *command],
            timeout=timeout,
            env=dict(env) if env is not None else build_sandbox_environment(),
            require_pid_namespace=True,
            stdin_data=stdin_data,
        )

    def command_prefix_for(
        self,
        *,
        read_only_workspace: bool = False,
        unshare_network: bool = False,
        read_only_paths: Sequence[Path] = (),
        extra_read_only_mounts: Sequence[ReadOnlyMount] = (),
    ) -> list[str]:
        """Build a stricter command boundary from this session's fixed roots.

        Model sessions use ``read_only_paths`` to freeze the evaluated skill
        roots. Verifiers use ``read_only_workspace`` so candidate-authored code
        cannot change the credited implementation. Extra mounts are reserved
        for harness-owned, post-session evidence such as hidden oracles.
        """

        additional: list[ReadOnlyMount] = []
        clone = _real_directory(self.clone, label="sandbox clone")
        for raw_path in read_only_paths:
            lexical = raw_path.expanduser().absolute()
            try:
                relative = lexical.relative_to(clone)
                metadata = lexical.lstat()
                resolved = lexical.resolve(strict=True)
            except (OSError, ValueError) as exc:
                raise SandboxError(f"read-only sandbox path is unavailable: {raw_path}") from exc
            if (
                resolved != lexical
                or stat.S_ISLNK(metadata.st_mode)
                or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode))
            ):
                raise SandboxError(f"read-only sandbox path must be real and non-symlink: {raw_path}")
            additional.append(
                ReadOnlyMount(
                    source=lexical,
                    target=f"{SANDBOX_WORKSPACE}/{PurePosixPath(relative.as_posix())}",
                )
            )

        for mount in extra_read_only_mounts:
            source = mount.source.expanduser().absolute()
            try:
                metadata = source.lstat()
                resolved = source.resolve(strict=True)
            except OSError as exc:
                raise SandboxError(f"extra read-only mount is unavailable: {source}") from exc
            if (
                resolved != source
                or stat.S_ISLNK(metadata.st_mode)
                or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode))
            ):
                raise SandboxError(f"extra read-only mount must be real and non-symlink: {source}")
            target = PurePosixPath(mount.target)
            if not target.is_absolute() or ".." in target.parts:
                raise SandboxError(f"extra read-only mount target must be absolute: {mount.target}")
            additional.append(ReadOnlyMount(source=source, target=target.as_posix()))

        return _sandbox_command_prefix(
            bwrap=self.bwrap_bin,
            clone=clone,
            home=self.home,
            temp=self.temp,
            claude_bin=self.claude_host_bin,
            mounts=(*self.read_only_mounts, *additional),
            read_only_workspace=read_only_workspace,
            unshare_network=unshare_network,
        )


_TOKEN_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"),
    re.compile(r"gh(?:p|o|u|s|r)_[A-Za-z0-9_]{8,}"),
    re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+"),
    re.compile(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@"),
)


def redact_text(text: str, secrets: Sequence[str] = ()) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = _TOKEN_PATTERNS[0].sub("[REDACTED]", text)
    text = _TOKEN_PATTERNS[1].sub("[REDACTED]", text)
    text = _TOKEN_PATTERNS[2].sub(r"\1[REDACTED]", text)
    return _TOKEN_PATTERNS[3].sub(r"\1[REDACTED]@", text)


def _evidence_bytes(value: Any, secrets: Sequence[str]) -> bytes:
    if isinstance(value, Path):
        try:
            mode = value.lstat().st_mode
        except OSError as exc:
            raise SandboxError(f"evidence path is unreadable: {value}: {exc}") from exc
        if value.is_symlink() or not stat.S_ISREG(mode):
            raise SandboxError(f"evidence must be a regular non-symlink file: {value}")
        if value.stat().st_size > MAX_EVIDENCE_FILE_BYTES:
            raise SandboxError(f"evidence exceeds the per-file limit: {value}")
        raw = value.read_bytes()
        return redact_text(raw.decode(errors="replace"), secrets).encode()
    if isinstance(value, bytes):
        raw = value
    elif isinstance(value, str):
        raw = value.encode()
    else:
        raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    return redact_text(raw.decode(errors="replace"), secrets).encode()


def stage_evidence_bundle(
    destination: Path,
    entries: Mapping[str, Any],
    *,
    secrets: Sequence[str] = (),
) -> Path:
    """Write a redacted owner-only evidence bundle with hard byte caps."""

    destination = destination.resolve()
    if destination.exists():
        raise SandboxError(f"evidence destination already exists: {destination}")
    destination.mkdir(parents=True, mode=0o700)
    destination.chmod(0o700)
    total = 0
    try:
        for name, value in entries.items():
            relative = PurePosixPath(name)
            if len(relative.parts) != 1 or relative.name in {"", ".", ".."}:
                raise SandboxError(f"evidence names must be simple relative files: {name!r}")
            payload = _evidence_bytes(value, secrets)
            if len(payload) > MAX_EVIDENCE_FILE_BYTES:
                raise SandboxError(f"evidence exceeds the per-file limit: {name}")
            total += len(payload)
            if total > MAX_BUNDLE_BYTES:
                raise SandboxError("evidence bundle exceeds the total byte limit")
            path = destination / relative.name
            path.write_bytes(payload)
            path.chmod(0o600)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return destination


def _validated_base_url(base_url: str) -> str:
    value = base_url.strip()
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SandboxError("model base URL must be an HTTP(S) endpoint without credentials, query, or fragment")
    return value


def build_sandbox_environment(
    *,
    auth_token: str | None = None,
    base_url: str | None = None,
) -> dict[str, str]:
    """Build the entire parent environment; never copy ``os.environ``."""

    env = {
        "HOME": SANDBOX_HOME,
        "USER": "agent",
        "LOGNAME": "agent",
        "TMPDIR": SANDBOX_TMP,
        "XDG_CONFIG_HOME": f"{SANDBOX_HOME}/.config",
        "XDG_CACHE_HOME": f"{SANDBOX_HOME}/.cache",
        "XDG_STATE_HOME": f"{SANDBOX_HOME}/.local/state",
        "PATH": SANDBOX_PATH,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "CI": "1",
        "NO_COLOR": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "NPM_CONFIG_UPDATE_NOTIFIER": "false",
        "NPM_CONFIG_AUDIT": "false",
        "NPM_CONFIG_FUND": "false",
        "NPM_CONFIG_CACHE": f"{SANDBOX_TMP}/npm-cache",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_TELEMETRY": "1",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1",
        "CLAUDE_CODE_DONT_INHERIT_ENV": "1",
        "CLAUDE_CODE_SHELL_PREFIX": SANDBOX_SHELL_PREFIX,
        "CLAUDE_CONFIG_DIR": f"{SANDBOX_HOME}/.claude",
    }
    if auth_token is not None:
        token = auth_token.strip()
        if not token:
            raise SandboxError("model auth token must not be blank")
        # Every benchmark/proposer invocation uses Claude's --bare mode,
        # which intentionally ignores OAuth/keychain/AUTH_TOKEN credentials.
        env["ANTHROPIC_API_KEY"] = token
    if base_url is not None:
        env["ANTHROPIC_BASE_URL"] = _validated_base_url(base_url)
    return env


def build_claude_settings() -> str:
    """Inline settings: hooks/plugins are absent and every Bash stays sandboxed."""

    settings = {
        "sandbox": {
            "enabled": True,
            "failIfUnavailable": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "enableWeakerNestedSandbox": True,
            "network": {
                "allowedDomains": [],
                "deniedDomains": ["*"],
                "allowAllUnixSockets": False,
                "allowLocalBinding": False,
            },
            "filesystem": {
                "allowWrite": [SANDBOX_WORKSPACE, SANDBOX_TMP, SANDBOX_HOME],
                "denyRead": ["/"],
                "allowRead": [
                    SANDBOX_WORKSPACE,
                    SANDBOX_TMP,
                    SANDBOX_HOME,
                    "/usr",
                    "/bin",
                    "/lib",
                    "/lib64",
                    "/opt/claude",
                    SANDBOX_GITNEXUS,
                    SANDBOX_GITNEXUS_SHARED,
                    SANDBOX_GITNEXUS_REGISTRY,
                ],
            },
        },
        "permissions": {
            # CLAUDE_CODE_SUBPROCESS_ENV_SCRUB forces permission mode to
            # "default" (allowed_non_write_users hardening), so requesting a
            # non-default mode only emits a warning and never takes effect.
            # Under "default" a tool runs without a prompt only if it matches an
            # allow rule, so pre-approve the proposer's exact tool surface. Bash
            # is the only writable tool under --bare (it writes the candidate
            # overlay) and stays sandbox-confined by the sandbox.* policy above.
            "allow": ["Read", "Grep", "Glob", "Bash"],
            "disableBypassPermissionsMode": "disable",
        },
        "env": {
            "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1",
            "CLAUDE_CODE_DONT_INHERIT_ENV": "1",
        },
    }
    return json.dumps(settings, sort_keys=True, separators=(",", ":"))


def _runtime_mount_args() -> list[str]:
    args: list[str] = []
    system_trees = ("/usr", "/bin", "/lib", "/lib64")
    for raw in system_trees:
        path = Path(raw)
        if path.exists():
            args += ["--ro-bind", raw, raw]
    # sanitized_graph.py and runner_sessions.py invoke the sandboxed graph
    # CLI via SANDBOX_NODE. Bind whatever `node` actually resolves to on PATH
    # there -- true node location varies by host (GitHub-hosted runner images
    # happen to have one under /usr/local/bin; a self-hosted runner's
    # actions/setup-node installs into its own tool-cache directory instead).
    # Target must be a fresh path like /opt/claude/... rather than anywhere
    # under /usr, /bin, /lib, or /lib64: those are already read-only bound
    # above, and bwrap can't create a new mount-point file inside an
    # already-read-only tree when the real path doesn't already exist there
    # (the exact case a self-hosted runner hits, and the reason this bind
    # exists at all).
    node_bin = shutil.which("node")
    if node_bin:
        args += ["--ro-bind", node_bin, SANDBOX_NODE]
        # The single-binary bind above gives SANDBOX_NODE but NOT npm or npx:
        # those are symlinks into ../lib/node_modules/npm/bin/*-cli.js, so the
        # install prefix carrying both bin/ and lib/node_modules has to be
        # mounted for them to resolve at all. When node really lives under a
        # system tree (/usr/local/bin on GitHub-hosted images) the prefix is
        # already inside the wholesale read-only binds above and npm/npx came
        # along for free -- which is exactly why this gap stayed invisible
        # until a self-hosted runner put node in actions/setup-node's tool
        # cache, outside /usr, and every task verify command
        # ("cd gitnexus && npx tsc ... && npx vitest ...") died with
        # "/bin/sh: 1: npx: not found". Skip the redundant bind in the
        # already-covered case so the mount surface stays minimal.
        #
        # The prefix is only ever derived from a real <prefix>/bin/node layout
        # that actually carries npm. Deriving it as parent.parent unconditionally
        # would mount an unrelated ancestor whenever node sits somewhere else:
        # /opt/bin/node would bind all of /opt (every tool cache on a hosted
        # runner) and a bare <dir>/node would bind <dir>'s parent. This function
        # exists to keep the sandbox surface minimal, so an unrecognized layout
        # binds nothing extra and simply leaves npx unavailable, exactly as
        # before.
        node_bin_dir = Path(node_bin).resolve().parent
        node_prefix = node_bin_dir.parent
        # Test the property actually needed -- a working npx next to node in a
        # real bin/ directory -- rather than a proxy like lib/node_modules/npm.
        # .exists() follows the symlink, so a dangling npx correctly fails: it
        # would not survive the mount either. Requiring the "bin" name keeps
        # the parent.parent derivation honest; an npx sitting directly beside
        # node in a flat directory would make that derivation name the wrong
        # prefix.
        provides_npx = node_bin_dir.name == "bin" and (node_bin_dir / "npx").exists()
        if provides_npx and not any(node_prefix.is_relative_to(tree) for tree in system_trees):
            args += ["--ro-bind", str(node_prefix), SANDBOX_NODE_PREFIX]
    for raw in (
        "/etc/ssl",
        "/etc/hosts",
        "/etc/resolv.conf",
        "/etc/nsswitch.conf",
        "/etc/passwd",
        "/etc/group",
    ):
        path = Path(raw)
        if path.exists():
            args += ["--ro-bind", raw, raw]
    return args


def _create_shell_prefix_wrapper(private_root: Path) -> Path:
    """Create Claude's immutable clean-environment command adapter."""

    wrapper = private_root / "shell-prefix"
    wrapper.write_text(
        "#!/bin/bash\n"
        "set -eu\n"
        'if [ "$#" -ne 1 ]; then exit 64; fi\n'
        "exec /usr/bin/env -i "
        f"HOME={SANDBOX_HOME} USER=agent LOGNAME=agent TMPDIR={SANDBOX_TMP} "
        f"PATH={SANDBOX_PATH} LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=dumb "
        '/bin/bash -c "$1"\n'
    )
    wrapper.chmod(0o500)
    return wrapper


def _create_python3_wrapper(private_root: Path) -> Path:
    """A trusted, self-owned Python 3 launcher for evidence-provenance.mjs's atomic mover.

    /usr/bin/python3 is a real system binary, but it's root-owned on the host.
    Inside this --unshare-user sandbox only the calling uid is mapped (root is
    not), so root-owned files surface as the kernel's overflow uid — which
    evidence-provenance.mjs's PATH-scan correctly refuses to trust. This
    wrapper is freshly created by the same host process that owns
    home/temp/shell-prefix, so it maps to the sandbox's own trusted uid
    instead, and simply execs the real interpreter through to do the work.
    """

    wrapper = private_root / "python3"
    wrapper.write_text('#!/bin/bash\nset -eu\nexec /usr/bin/python3 "$@"\n')
    wrapper.chmod(0o500)
    return wrapper


def _resolve_executable(executable: Path | str | None, default: str) -> Path:
    raw = os.fspath(executable) if executable is not None else shutil.which(default)
    if not raw:
        raise SandboxError(f"required executable is unavailable: {default}")
    path = Path(raw).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise SandboxError(f"required executable is not an executable regular file: {path}")
    return path


def preflight_bubblewrap(bwrap_bin: Path | str | None = None) -> Path:
    """Prove the required namespaces work; never fall back to host execution."""

    if sys.platform != "linux":
        raise SandboxError(f"Bubblewrap containment is supported only on Linux/WSL2, not {sys.platform}")
    bwrap = _resolve_executable(bwrap_bin, "bwrap")
    command = [
        str(bwrap),
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        *_runtime_mount_args(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/usr/bin/true",
    ]
    result = run_managed(command, timeout=10, require_pid_namespace=True)
    if not result.ok:
        raise SandboxError(f"Bubblewrap namespace preflight failed: {result.detail or result.stderr_tail[-1000:]}")
    return bwrap


def pid_namespace_command(
    command: Sequence[str],
    *,
    bwrap_bin: Path,
) -> list[str]:
    """Wrap a trusted host command in an owned PID namespace.

    This boundary deliberately preserves the host filesystem and network; its
    sole purpose is making every descendant visible to the outer driver even
    when a nested command creates a new session or process group.
    """

    if not command:
        raise ValueError("PID-namespace command must not be empty")
    return [
        str(bwrap_bin),
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        *command,
    ]


def require_claude_sandbox_helpers() -> None:
    """Fail before paid work when Claude's mandatory inner sandbox cannot run."""

    _resolve_executable(None, "socat")


def _real_directory(path: Path, *, label: str) -> Path:
    """Return an absolute directory path without accepting any symlink hop."""

    lexical = path.expanduser().absolute()
    try:
        mode = lexical.lstat().st_mode
    except OSError as exc:
        raise SandboxError(f"{label} must be a real directory: {lexical}: {exc}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise SandboxError(f"{label} must be a real directory: {lexical}")
    try:
        resolved = lexical.resolve(strict=True)
    except OSError as exc:
        raise SandboxError(f"{label} must be a real directory: {lexical}: {exc}") from exc
    if resolved != lexical:
        raise SandboxError(f"{label} must not traverse symlinks: {lexical}")
    return lexical


def _safe_repo_source(repo: Path, relative: str, *, label: str) -> tuple[Path, Path]:
    candidate = PurePosixPath(relative)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise SandboxError(f"{label} must be a repository-relative path: {relative!r}")
    lexical = repo / Path(*candidate.parts)
    resolved = lexical.resolve()
    try:
        resolved.relative_to(repo)
    except ValueError as exc:
        raise SandboxError(f"{label} escapes its allowed repository root: {relative}") from exc
    if not resolved.exists():
        raise SandboxError(f"{label} does not exist: {relative}")
    return lexical, resolved


def _prepare_clone_target(
    clone: Path,
    relative: PurePosixPath,
    *,
    directory: bool | None,
    label: str,
) -> Path:
    """Validate/create a clone-local target without following any symlink.

    This runs before Bubblewrap, so ordinary ``Path.mkdir``/``touch`` calls
    are not acceptable: an untrusted tracked parent symlink could redirect a
    mount placeholder write into the host filesystem.
    """

    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    current_fd = os.open(clone, flags | nofollow)
    try:
        for part in relative.parts[:-1]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=current_fd)
            except FileExistsError:
                pass
            try:
                next_fd = os.open(part, flags | nofollow, dir_fd=current_fd)
            except OSError as exc:
                raise SandboxError(f"{label} target has a non-directory or symlink parent: {relative}") from exc
            os.close(current_fd)
            current_fd = next_fd

        leaf = relative.parts[-1]
        try:
            mode = os.stat(leaf, dir_fd=current_fd, follow_symlinks=False).st_mode
        except FileNotFoundError:
            mode = None
        if mode is not None and stat.S_ISLNK(mode):
            raise SandboxError(f"{label} target cannot be a symlink: {relative}")
        if directory is True:
            if mode is None:
                os.mkdir(leaf, mode=0o700, dir_fd=current_fd)
            elif not stat.S_ISDIR(mode):
                raise SandboxError(f"{label} directory target has the wrong type: {relative}")
        elif directory is False:
            if mode is None:
                file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
                file_fd = os.open(leaf, file_flags, 0o600, dir_fd=current_fd)
                os.close(file_fd)
            elif not stat.S_ISREG(mode):
                raise SandboxError(f"{label} file target has the wrong type: {relative}")
        elif mode is not None and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SandboxError(f"{label} target has the wrong type: {relative}")
    finally:
        os.close(current_fd)
    return clone / Path(*relative.parts)


def stage_task_assets(
    task: Mapping[str, Any],
    *,
    repo: Path,
    clone: Path,
) -> list[ReadOnlyMount]:
    """Compatibility wrapper for immutable task-asset staging."""

    # Kept lazy to avoid a module cycle: task_assets uses the sandbox's
    # shared error, mount, and no-follow target primitives.
    from .task_assets import stage_task_assets as stage_immutable_task_assets

    return stage_immutable_task_assets(task, repo=repo, clone=clone)


def _sandbox_command_prefix(
    *,
    bwrap: Path,
    clone: Path,
    home: Path,
    temp: Path,
    claude_bin: Path,
    mounts: Sequence[ReadOnlyMount],
    read_only_workspace: bool = False,
    unshare_network: bool = False,
) -> list[str]:
    args = [
        str(bwrap),
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        *(["--unshare-net"] if unshare_network else []),
        "--die-with-parent",
        "--new-session",
        *_runtime_mount_args(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/run",
        "--ro-bind" if read_only_workspace else "--bind",
        str(clone),
        SANDBOX_WORKSPACE,
        "--bind",
        str(home),
        SANDBOX_HOME,
        "--bind",
        str(temp),
        SANDBOX_TMP,
        "--ro-bind",
        str(claude_bin),
        SANDBOX_CLAUDE,
    ]
    for mount in mounts:
        args += ["--ro-bind", str(mount.source), mount.target]
        # Overlay an empty writable tmpfs on the one path vite must write.
        # Everything else in the mount, and the whole workspace, stays
        # read-only, and the overlay lives only inside the sandbox -- it never
        # reaches the host clone the credited patch is captured from.
        #
        # Gate on the mount SOURCE actually containing the directory, not on
        # the target name: bwrap cannot create a mount point inside an
        # already-read-only bind, so a tmpfs can only be overlaid where the
        # directory already exists in the bound bytes. task_assets.py captures
        # it into dependency-snapshot node_modules; other node_modules mounts
        # (e.g. the trusted GitNexus runtime at /opt/gitnexus/node_modules) do
        # not carry it, and overlaying them would fail with EROFS.
        if PurePosixPath(mount.target).name == DEPENDENCY_MOUNT_BASENAME and (mount.source / VITE_TEMP_DIR).is_dir():
            args += ["--tmpfs", f"{mount.target}/{VITE_TEMP_DIR}"]
    args += ["--chdir", SANDBOX_WORKSPACE, "--"]
    return args


@contextmanager
def prepare_sandbox(
    *,
    clone: Path,
    claude_bin: Path | str | None = None,
    bwrap_bin: Path | str | None = None,
    read_only_mounts: Sequence[ReadOnlyMount] = (),
    preflight: bool = True,
) -> Iterator[SandboxSession]:
    """Create private host backing dirs and one immutable Bubblewrap command."""

    # Validate the lexical path before resolving it. Resolving first would
    # erase the evidence that the caller supplied a symlinked clone root.
    clone = _real_directory(clone, label="sandbox clone")
    if preflight:
        bwrap = preflight_bubblewrap(bwrap_bin)
        require_claude_sandbox_helpers()
    else:
        bwrap = _resolve_executable(bwrap_bin, "bwrap")
    claude = _resolve_executable(claude_bin, "claude")
    private_root = Path(tempfile.mkdtemp(prefix="wfbench-sandbox-"))
    private_root.chmod(0o700)
    home = private_root / "home"
    temp = private_root / "tmp"
    for directory in (home, temp):
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)
    shell_prefix = _create_shell_prefix_wrapper(private_root)
    python3_wrapper = _create_python3_wrapper(private_root)
    # Claude may discover user-level skills below HOME.  Keep the rest of HOME
    # writable for normal CLI state, but overlay an immutable empty skills root
    # so a model cannot shadow the evaluated repository/plugin skill by name.
    user_skills = home / ".claude" / "skills"
    user_skills.mkdir(parents=True, mode=0o500)
    user_skills.chmod(0o500)
    protected_mounts = (
        *read_only_mounts,
        ReadOnlyMount(source=user_skills, target=SANDBOX_USER_SKILLS),
        ReadOnlyMount(source=shell_prefix, target=SANDBOX_SHELL_PREFIX),
        ReadOnlyMount(source=python3_wrapper, target=SANDBOX_PYTHON3),
    )
    primary: BaseException | None = None
    try:
        command_prefix = _sandbox_command_prefix(
            bwrap=bwrap,
            clone=clone,
            home=home,
            temp=temp,
            claude_bin=claude,
            mounts=protected_mounts,
        )
        yield SandboxSession(
            private_root=private_root,
            clone=clone,
            home=home,
            temp=temp,
            bwrap_bin=bwrap,
            claude_host_bin=claude,
            command_prefix=command_prefix,
            read_only_mounts=protected_mounts,
        )
    except BaseException as exc:
        primary = exc
        raise
    finally:
        try:
            shutil.rmtree(private_root)
        except OSError as cleanup:
            if primary is None:
                raise
            primary.add_note(f"sandbox cleanup also failed: {type(cleanup).__name__}: {cleanup}")
