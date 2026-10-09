"""Candidate builds must fail closed before any uncontained lifecycle script runs."""

from pathlib import Path

import pytest

from workflow_bench import release_build
from workflow_bench.proposer_sandbox import SandboxError


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
    (command,), kwargs = calls[0]
    assert kwargs == {"timeout": 1200, "env": {}}
    assert '--clearenv' in command
    at = command.index('--bind')
    assert command[at + 1:at + 3] == [str(tmp_path), '/workspace']
    assert command.count('--bind') == 1
    assert [command[i + 1] for i, v in enumerate(command) if v == '--setenv'] == ['PATH', 'HOME']
    assert '--unshare-pid' in command and '--cap-drop' in command
    assert 'npm ci' in command[-1] and 'npm run build --prefix gitnexus' in command[-1]


def test_candidate_build_mounts_git_metadata_read_only_over_the_writable_checkout(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(release_build, "preflight_bubblewrap", lambda: Path('/usr/bin/bwrap'))
    monkeypatch.setattr(release_build, "run_checked", lambda *a, **k: calls.append(a))
    (tmp_path / ".git").mkdir()
    release_build.build_candidate(tmp_path)
    (command,) = calls[0]
    # bwrap applies mounts in order, so the read-only overlay must follow the writable bind.
    at = command.index('--bind')
    assert command[at:at + 6] == ['--bind', str(tmp_path), '/workspace', '--ro-bind', str(tmp_path / ".git"), '/workspace/.git']
