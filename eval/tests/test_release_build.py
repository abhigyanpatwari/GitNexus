"""Candidate builds must fail closed before any uncontained lifecycle script runs."""

from pathlib import Path

import pytest

from workflow_bench import release_build
from workflow_bench.proposer_sandbox import SandboxError, bwrap_base_args


def test_candidate_build_refuses_unavailable_containment_before_npm(monkeypatch, tmp_path):
    calls = []

    def unavailable():
        raise SandboxError("no containment")

    monkeypatch.setattr(release_build, "preflight_bubblewrap", unavailable)
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a))
    with pytest.raises(SandboxError, match="no containment"):
        release_build.build_candidate(tmp_path)
    assert calls == []


def test_candidate_build_rejects_symlinked_checkout_before_execution(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a))
    link = tmp_path / "candidate"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(SandboxError, match="real directory"):
        release_build.build_candidate(link)
    assert calls == []


def test_candidate_build_clears_tokens_and_mounts_only_candidate_writable(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "preflight_bubblewrap", lambda: Path('/usr/bin/bwrap'))
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append((a, k)))
    release_build.build_candidate(tmp_path)
    assert len(calls) == 2
    for (command,), kwargs in calls:
        assert kwargs == {"timeout": 1200, "env": {}}
        assert '--clearenv' in command
        at = command.index('--bind')
        assert command[at + 1:at + 3] == [str(tmp_path), '/workspace']
        assert command.count('--bind') == 1
        assert [command[i + 1] for i, v in enumerate(command) if v == '--setenv'] == ['PATH', 'HOME']
        assert '--unshare-pid' in command and '--cap-drop' in command


def test_candidate_downloads_without_scripts_then_runs_every_script_offline(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "preflight_bubblewrap", lambda: Path('/usr/bin/bwrap'))
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a[0]))
    release_build.build_candidate(tmp_path)
    download, scripts = calls
    assert "--unshare-net" not in download
    assert download[-1].splitlines()[1:] == [
        "npm ci --ignore-scripts --audit=false --fund=false",
        "npm ci --prefix gitnexus --ignore-scripts --audit=false --fund=false",
    ]
    assert "--unshare-net" in scripts
    assert scripts[-1].splitlines()[1:] == [
        "npm rebuild --foreground-scripts",
        "npm rebuild --prefix gitnexus --foreground-scripts",
        "npm run build --prefix gitnexus",
        "mkdir -p gitnexus-shared/node_modules",
    ]


def test_candidate_build_mounts_git_metadata_read_only_over_the_writable_checkout(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "preflight_bubblewrap", lambda: Path('/usr/bin/bwrap'))
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a))
    (tmp_path / ".git").mkdir()
    release_build.build_candidate(tmp_path)
    assert len(calls) == 2
    for (command,) in calls:
        # bwrap applies mounts in order, so the read-only overlay must follow the writable bind.
        at = command.index('--bind')
        assert command[at:at + 6] == ['--bind', str(tmp_path), '/workspace', '--ro-bind', str(tmp_path / ".git"), '/workspace/.git']


def test_candidate_build_uses_the_shared_bubblewrap_preamble_with_all_capabilities_dropped(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "preflight_bubblewrap", lambda: Path("/usr/bin/bwrap"))
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a))
    release_build.build_candidate(tmp_path)
    (download,), (scripts,) = calls
    preamble = bwrap_base_args(cap_drop_all=True)
    assert download[1 : 1 + len(preamble)] == preamble
    offline = bwrap_base_args(unshare_network=True, cap_drop_all=True)
    assert scripts[1 : 1 + len(offline)] == offline
    at = preamble.index("--cap-drop")
    assert preamble[at : at + 2] == ["--cap-drop", "ALL"]
    assert "--unshare-net" not in preamble
    assert "--cap-drop" not in bwrap_base_args()
