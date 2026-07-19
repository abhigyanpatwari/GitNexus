"""Tests for evidence-bound, transactional promotion application."""

import json
import os
import stat
from pathlib import Path, PurePosixPath

import pytest

from workflow_bench import evolve, promotion_apply
from workflow_bench.evolution import (
    CANDIDATE_SKILLS,
    MAX_CANDIDATE_OVERLAY_BYTES,
    candidate_overlay_digest,
    candidate_overlay_payload,
)
from workflow_bench.promotion_apply import (
    apply_promoted_overlay,
    committed_destination_base_digests,
    destination_base_digests,
    freeze_overlay,
    mirror_targets,
)


def _git(repo: Path, *arguments: str) -> str:
    return (
        __import__("subprocess")
        .run(
            ["git", "-C", str(repo), *arguments],
            check=True,
            capture_output=True,
            text=True,
        )
        .stdout.strip()
    )


def test_evolve_reexports_public_promotion_helpers():
    assert evolve.mirror_targets is mirror_targets
    assert evolve.freeze_overlay is freeze_overlay
    assert evolve.destination_base_digests is destination_base_digests
    assert evolve.apply_promoted_overlay is apply_promoted_overlay


def test_mirror_targets_cover_canonical_and_shipped_copies():
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    assert targets == [
        PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"),
        PurePosixPath("gitnexus/skills/gitnexus-plan/SKILL.md"),
        PurePosixPath("gitnexus-claude-plugin/skills/gitnexus-plan/SKILL.md"),
    ]


def test_apply_promoted_overlay_writes_all_mirrors(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("evolved plan skill")
    repo = tmp_path / "repo"
    expected_targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in expected_targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    written = apply_promoted_overlay(overlay, repo_root=repo)

    assert written == [
        ".claude/skills/gitnexus-plan/SKILL.md",
        "gitnexus/skills/gitnexus-plan/SKILL.md",
        "gitnexus-claude-plugin/skills/gitnexus-plan/SKILL.md",
    ]
    contents = {(repo / path).read_text() for path in written}
    assert contents == {"evolved plan skill"}


def test_apply_promoted_overlay_rejects_destination_drift(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(f"old:{target}")
    expected_bases = destination_base_digests(overlay, repo_root=repo)
    drifted = repo / targets[1]
    drifted.write_text("concurrent edit")

    with pytest.raises(ValueError, match="drifted=.*gitnexus-plan/SKILL.md"):
        apply_promoted_overlay(
            overlay,
            repo_root=repo,
            expected_target_bases=expected_bases,
        )

    assert drifted.read_text() == "concurrent edit"
    assert (repo / targets[0]).read_text() == f"old:{targets[0]}"
    assert (repo / targets[2]).read_text() == f"old:{targets[2]}"


def test_apply_promoted_overlay_preserves_edit_racing_atomic_exchange(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_exchange = promotion_apply._exchange_at
    raced = False

    def edit_before_exchange(parent_descriptor, source, destination):
        nonlocal raced
        if not raced:
            raced = True
            (repo / targets[0]).write_text("concurrent edit")
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", edit_before_exchange)
    with pytest.raises(RuntimeError, match="rolled back") as raised:
        apply_promoted_overlay(overlay, repo_root=repo)

    assert "atomic overlay exchange parity check failed" in str(raised.value.__cause__)
    assert (repo / targets[0]).read_text() == "concurrent edit"
    assert [(repo / target).read_text() for target in targets[1:]] == ["incumbent", "incumbent"]
    assert list(repo.rglob(".wfevolve-*")) == []


def test_apply_promoted_overlay_rolls_back_raced_edit_when_exchange_then_raises(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_exchange = promotion_apply._exchange_at
    exchanges = 0

    def edit_exchange_then_raise(parent_descriptor, source, destination):
        nonlocal exchanges
        exchanges += 1
        if exchanges == 1:
            (repo / targets[0]).write_text("concurrent edit")
            real_exchange(parent_descriptor, source, destination)
            raise OSError("injected post-exchange failure")
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", edit_exchange_then_raise)
    with pytest.raises(RuntimeError, match="rolled back"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert (repo / targets[0]).read_text() == "concurrent edit"
    assert [(repo / target).read_text() for target in targets[1:]] == ["incumbent", "incumbent"]
    assert list(repo.rglob(".wfevolve-*")) == []


def test_apply_promoted_overlay_preserves_second_edit_racing_rollback(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_exchange = promotion_apply._exchange_at
    exchanges = 0

    def edit_before_publication_and_rollback(parent_descriptor, source, destination):
        nonlocal exchanges
        exchanges += 1
        if exchanges == 1:
            (repo / targets[0]).write_text("first concurrent edit")
        elif exchanges == 2:
            (repo / targets[0]).write_text("second concurrent edit")
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", edit_before_publication_and_rollback)
    with pytest.raises(RuntimeError, match="rollback was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["transaction_state"] == "rollback-incomplete"
    raced_target = next(entry for entry in recovery["backups"] if entry["target"] == targets[0].as_posix())
    assert Path(raced_target["candidate"]).read_text() == "second concurrent edit"
    assert (repo / targets[0]).read_text() == "first concurrent edit"


def test_apply_promoted_overlay_preserves_mode_change_racing_exchange(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")
        destination.chmod(0o644)

    real_exchange = promotion_apply._exchange_at
    raced = False

    def chmod_before_exchange(parent_descriptor, source, destination):
        nonlocal raced
        if not raced:
            raced = True
            (repo / targets[0]).chmod(0o600)
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", chmod_before_exchange)
    with pytest.raises(RuntimeError, match="rolled back"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert (repo / targets[0]).read_text() == "incumbent"
    assert stat.S_IMODE((repo / targets[0]).stat().st_mode) == 0o600
    assert list(repo.rglob(".wfevolve-*")) == []


def test_apply_promoted_overlay_treats_candidate_hardlinked_at_both_names_as_incomplete(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_exchange = promotion_apply._exchange_at
    linked = False

    def hardlink_candidate_before_exchange(parent_descriptor, source, destination):
        nonlocal linked
        if not linked:
            linked = True
            os.unlink(destination, dir_fd=parent_descriptor)
            os.link(
                source,
                destination,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", hardlink_candidate_before_exchange)
    with pytest.raises(RuntimeError, match="rollback was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert (repo / targets[0]).read_text() == "candidate"
    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["transaction_state"] == "rollback-incomplete"
    assert "linked at both" in recovery["rollback_failures"][0]
    assert Path(recovery["backups"][0]["backup"]).read_text() == "incumbent"


def test_apply_promoted_overlay_rolls_back_every_completed_replace(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(f"old:{target}")
    originals = {target: (repo / target).read_bytes() for target in targets}

    real_exchange = promotion_apply._exchange_at
    replacements = 0

    def fail_second_exchange(parent_descriptor, source, destination):
        nonlocal replacements
        replacements += 1
        if replacements == 2:
            raise OSError("injected replacement failure")
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", fail_second_exchange)
    with pytest.raises(RuntimeError, match="rolled back"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert {target: (repo / target).read_bytes() for target in targets} == originals


def test_apply_promoted_overlay_rolls_back_when_replace_lands_then_interrupts(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(f"old:{target}")
    originals = {target: (repo / target).read_bytes() for target in targets}
    expected_bases = destination_base_digests(overlay, repo_root=repo)

    real_exchange = promotion_apply._exchange_at
    apply_replacements = 0

    def interrupt_after_second_landed_exchange(parent_descriptor, source, destination):
        nonlocal apply_replacements
        result = real_exchange(parent_descriptor, source, destination)
        if destination == "SKILL.md":
            apply_replacements += 1
            if apply_replacements == 2:
                raise KeyboardInterrupt("injected post-replace interruption")
        return result

    monkeypatch.setattr(promotion_apply, "_exchange_at", interrupt_after_second_landed_exchange)
    with pytest.raises(KeyboardInterrupt, match="post-replace"):
        apply_promoted_overlay(
            overlay,
            repo_root=repo,
            expected_target_bases=expected_bases,
        )

    assert {target: (repo / target).read_bytes() for target in targets} == originals


def test_apply_promoted_overlay_prevalidates_all_targets_before_staging(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    first = repo / mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))[0]
    first.parent.mkdir(parents=True)
    first.write_text("incumbent")

    with pytest.raises(ValueError, match="destination (parent is unavailable|must already be a regular file)"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert first.read_text() == "incumbent"
    assert list(repo.rglob(".wfevolve-*")) == []


def test_apply_promoted_overlay_rejects_internal_symlink_ancestor(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in (targets[0], targets[2]):
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")
    redirected = repo / "redirected"
    redirected.mkdir(parents=True)
    (redirected / "SKILL.md").write_text("must-not-change")
    symlink_parent = repo / targets[1].parent
    symlink_parent.parent.mkdir(parents=True, exist_ok=True)
    symlink_parent.symlink_to(redirected, target_is_directory=True)

    with pytest.raises(ValueError, match="must not be a symlink"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert (redirected / "SKILL.md").read_text() == "must-not-change"
    assert (repo / targets[0]).read_text() == "incumbent"


def test_apply_promoted_overlay_rejects_repository_swap_during_root_open(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    replacement_repo = tmp_path / "replacement-repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for root, content in ((repo, "incumbent"), (replacement_repo, "replacement")):
        for target in targets:
            destination = root / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content)

    detached_repo = tmp_path / "detached-repo"
    real_open = promotion_apply.os.open
    swapped = False

    def swap_before_root_open(path, flags, mode=0o777, *, dir_fd=None):
        nonlocal swapped
        if not swapped and dir_fd is None and Path(path) == repo and flags & os.O_DIRECTORY:
            swapped = True
            repo.rename(detached_repo)
            replacement_repo.rename(repo)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(promotion_apply.os, "open", swap_before_root_open)
    with pytest.raises(ValueError, match="repository root changed while opening"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert [(detached_repo / target).read_text() for target in targets] == ["incumbent"] * 3
    assert [(repo / target).read_text() for target in targets] == ["replacement"] * 3
    assert list(tmp_path.rglob(".wfevolve-*")) == []


def test_apply_promoted_overlay_rejects_detached_parent_after_preparation(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    lexical_parent = (repo / targets[0]).parent
    detached_parent = lexical_parent.with_name("gitnexus-plan-detached")
    real_stage = promotion_apply._stage_replacement_at
    replaced = False

    def replace_parent_before_staging(parent_descriptor, content, mode):
        nonlocal replaced
        if not replaced:
            replaced = True
            lexical_parent.rename(detached_parent)
            lexical_parent.mkdir()
            (lexical_parent / "SKILL.md").write_text("incumbent")
        return real_stage(parent_descriptor, content, mode)

    monkeypatch.setattr(promotion_apply, "_stage_replacement_at", replace_parent_before_staging)

    with pytest.raises(RuntimeError, match="rolled back") as raised:
        apply_promoted_overlay(overlay, repo_root=repo)

    assert "destination parent changed" in str(raised.value.__cause__)
    assert (lexical_parent / "SKILL.md").read_text() == "incumbent"
    assert (detached_parent / "SKILL.md").read_text() == "incumbent"
    assert [(repo / target).read_text() for target in targets[1:]] == ["incumbent", "incumbent"]
    assert list(repo.rglob(".wfevolve-*")) == []


def test_committed_destination_bases_ignore_and_reject_live_target_edits(tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Workflow Bench Test")
    _git(repo, "config", "user.email", "workflow-bench@example.invalid")
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(f"committed:{target}")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "incumbent")

    expected = committed_destination_base_digests(overlay, repo_root=repo)
    dirty = repo / targets[1]
    dirty.write_text("user edit")

    assert destination_base_digests(overlay, repo_root=repo) != expected
    with pytest.raises(ValueError, match="drifted"):
        apply_promoted_overlay(
            overlay,
            repo_root=repo,
            expected_target_bases=expected,
        )
    assert dirty.read_text() == "user edit"


def test_mirror_roots_cover_every_candidate_skill_and_omit_none_that_ships_to_cursor():
    # promotion_apply.mirror_targets writes canonical + MIRROR_SKILL_ROOTS, which
    # today omits the Cursor tree. That is only safe because no candidate skill is
    # cursor-shipped. If a future edit adds a cursor-shipped skill (e.g.
    # gitnexus-review) to CANDIDATE_SKILLS, apply_promoted_overlay would rewrite
    # the other trees and silently skip Cursor — the PR #2488 asymmetric-sync bug
    # class. Pin the invariant to the filesystem, the source of truth the TS drift
    # guard already enforces.
    repo_root = Path(__file__).resolve().parents[2]
    cursor_root = repo_root / "gitnexus-cursor-integration" / "skills"
    for skill in sorted(CANDIDATE_SKILLS):
        canonical = repo_root / ".claude" / "skills" / skill
        assert canonical.is_dir(), f"candidate skill {skill} has no canonical .claude/skills dir"
        for target in mirror_targets(PurePosixPath(".claude", "skills", skill, "SKILL.md")):
            assert (repo_root / target).is_file(), f"candidate skill mirror missing on disk: {target}"
        assert not (cursor_root / skill).exists(), (
            f"candidate skill {skill} ships to Cursor, but MIRROR_SKILL_ROOTS does not cover "
            "gitnexus-cursor-integration/skills — promotion would sync it asymmetrically"
        )


def test_committed_destination_bases_reject_overlay_adding_uncommitted_target(tmp_path):
    # An overlay that adds a file absent at HEAD has no committed base to bind
    # against and raises ValueError — evolve.run / runner.main now catch that as
    # NOT PROMOTED / a clean CLI error instead of an uncaught traceback.
    overlay = tmp_path / "overlay"
    new_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "NEW.md"
    new_md.parent.mkdir(parents=True)
    new_md.write_text("brand new candidate file")
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Workflow Bench Test")
    _git(repo, "config", "user.email", "workflow-bench@example.invalid")
    (repo / "README.md").write_text("seed")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "seed")

    with pytest.raises(ValueError, match="committed overlay destination is unavailable"):
        committed_destination_base_digests(overlay, repo_root=repo)


def test_stage_replacement_removes_partial_file_when_fsync_fails(monkeypatch, tmp_path):
    destination = tmp_path / "SKILL.md"

    def fail_fsync(_descriptor):
        raise OSError("injected fsync failure")

    monkeypatch.setattr(promotion_apply.os, "fsync", fail_fsync)
    with pytest.raises(OSError, match="injected fsync failure"):
        promotion_apply._stage_replacement(destination, b"partial candidate", 0o644)

    assert list(tmp_path.glob(".wfevolve-*")) == []


def test_apply_promoted_overlay_names_recovery_state_if_rollback_fails(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_exchange = promotion_apply._exchange_at
    replacements = 0

    def fail_apply_and_rollback(parent_descriptor, source, destination):
        nonlocal replacements
        replacements += 1
        if replacements >= 2:
            raise OSError("injected persistent replacement failure")
        return real_exchange(parent_descriptor, source, destination)

    monkeypatch.setattr(promotion_apply, "_exchange_at", fail_apply_and_rollback)
    with pytest.raises(RuntimeError, match="rollback was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["rollback_failures"]
    assert any(Path(entry["backup"]).exists() for entry in recovery["backups"])


def test_apply_promoted_overlay_writes_recovery_into_held_root_after_relocation(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    replacement_repo = tmp_path / "replacement-repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for root, content in ((repo, "incumbent"), (replacement_repo, "replacement")):
        for target in targets:
            destination = root / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content)

    detached_repo = tmp_path / "detached-repo"
    real_exchange = promotion_apply._exchange_at
    exchanges = 0

    def relocate_after_exchange_then_fail(parent_descriptor, source, destination):
        nonlocal exchanges
        exchanges += 1
        if exchanges == 1:
            real_exchange(parent_descriptor, source, destination)
            repo.rename(detached_repo)
            replacement_repo.rename(repo)
            raise OSError("injected post-exchange relocation")
        raise OSError("injected rollback failure")

    monkeypatch.setattr(promotion_apply, "_exchange_at", relocate_after_exchange_then_fail)
    with pytest.raises(RuntimeError, match=r"recovery: .*detached-repo"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert list(repo.glob(".wfbench-overlay-recovery-*.json")) == []
    recovery_files = list(detached_repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["rollback_failures"]
    assert recovery["backups"]
    assert all(str(detached_repo) in entry["backup"] for entry in recovery["backups"])
    assert all(Path(entry["backup"]).exists() for entry in recovery["backups"])
    assert [(repo / target).read_text() for target in targets] == ["replacement"] * 3


def test_apply_promoted_overlay_reports_published_state_and_closes_descriptors_on_cleanup_failure(
    monkeypatch,
    tmp_path,
):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    captured_descriptors: list[int] = []
    real_prepare = promotion_apply._prepare_targets

    def capture_descriptors(payload, repo_root):
        root, root_descriptor, prepared = real_prepare(payload, repo_root)
        captured_descriptors.extend([root_descriptor, *(item["parent_descriptor"] for item in prepared)])
        return root, root_descriptor, prepared

    def fail_cleanup(_parent_descriptor, _name):
        raise OSError("injected cleanup failure")

    monkeypatch.setattr(promotion_apply, "_prepare_targets", capture_descriptors)
    monkeypatch.setattr(promotion_apply, "_unlink_temporary", fail_cleanup)
    with pytest.raises(RuntimeError, match="transaction is published.*cleanup was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert [(repo / target).read_text() for target in targets] == ["candidate"] * 3
    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["transaction_state"] == "published"
    assert recovery["backups"]
    for descriptor in captured_descriptors:
        with pytest.raises(OSError):
            os.fstat(descriptor)


def test_apply_promoted_overlay_tracks_candidate_when_backup_staging_and_cleanup_fail(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_stage = promotion_apply._stage_replacement_at
    stages = 0

    def fail_backup_stage(parent_descriptor, content, mode):
        nonlocal stages
        stages += 1
        if stages == 2:
            raise OSError("injected backup staging failure")
        return real_stage(parent_descriptor, content, mode)

    def fail_candidate_cleanup(_parent_descriptor, _name):
        raise OSError("injected candidate cleanup failure")

    monkeypatch.setattr(promotion_apply, "_stage_replacement_at", fail_backup_stage)
    monkeypatch.setattr(promotion_apply, "_unlink_temporary", fail_candidate_cleanup)
    with pytest.raises(RuntimeError, match="transaction is rolled-back.*cleanup was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["transaction_state"] == "rolled-back"
    assert len(recovery["backups"]) == 1
    assert recovery["backups"][0]["candidate_exists"]
    assert recovery["backups"][0]["backup"] is None
    assert Path(recovery["backups"][0]["candidate"]).exists()
    assert [(repo / target).read_text() for target in targets] == ["incumbent"] * 3


def test_apply_promoted_overlay_tracks_candidate_before_identity_capture(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_identity = promotion_apply._entry_identity_at
    identities = 0

    def fail_candidate_identity(parent_descriptor, name):
        nonlocal identities
        identities += 1
        if identities == 1:
            raise OSError("injected candidate identity failure")
        return real_identity(parent_descriptor, name)

    monkeypatch.setattr(promotion_apply, "_entry_identity_at", fail_candidate_identity)
    with pytest.raises(RuntimeError, match="rolled back"):
        apply_promoted_overlay(overlay, repo_root=repo)

    assert list(repo.rglob(".wfevolve-*")) == []
    assert [(repo / target).read_text() for target in targets] == ["incumbent"] * 3


def test_apply_promoted_overlay_tracks_stage_name_when_parent_fsync_and_unlink_fail(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    skill_md = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text("candidate")
    repo = tmp_path / "repo"
    targets = mirror_targets(PurePosixPath(".claude/skills/gitnexus-plan/SKILL.md"))
    for target in targets:
        destination = repo / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("incumbent")

    real_fsync = promotion_apply.os.fsync
    real_unlink = promotion_apply.os.unlink
    failed_parent_fsync = False

    def fail_first_parent_fsync(descriptor):
        nonlocal failed_parent_fsync
        if not failed_parent_fsync and stat.S_ISDIR(os.fstat(descriptor).st_mode):
            failed_parent_fsync = True
            raise OSError("injected parent fsync failure")
        return real_fsync(descriptor)

    def fail_staging_unlink(path, *args, **kwargs):
        if str(path).startswith(".wfevolve-"):
            raise OSError("injected staging unlink failure")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(promotion_apply.os, "fsync", fail_first_parent_fsync)
    monkeypatch.setattr(promotion_apply.os, "unlink", fail_staging_unlink)
    with pytest.raises(RuntimeError, match="transaction is rolled-back.*cleanup was incomplete; recovery:"):
        apply_promoted_overlay(overlay, repo_root=repo)

    recovery_files = list(repo.glob(".wfbench-overlay-recovery-*.json"))
    assert len(recovery_files) == 1
    recovery = json.loads(recovery_files[0].read_text())
    assert recovery["transaction_state"] == "rolled-back"
    assert len(recovery["backups"]) == 1
    assert recovery["backups"][0]["candidate_exists"]
    assert Path(recovery["backups"][0]["candidate"]).exists()
    assert [(repo / target).read_text() for target in targets] == ["incumbent"] * 3


def test_freeze_overlay_detaches_authorized_bytes_from_mutable_input(tmp_path):
    overlay = tmp_path / "overlay"
    source = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    source.parent.mkdir(parents=True)
    source.write_text("authorized")
    frozen = tmp_path / "frozen"

    digest = freeze_overlay(overlay, frozen)
    source.write_text("mutated later")

    assert candidate_overlay_digest(frozen) == digest
    assert (frozen / source.relative_to(overlay)).read_text() == "authorized"


def test_freeze_overlay_matches_canonical_payload_digest_and_byte_boundary(tmp_path):
    overlay = tmp_path / "overlay"
    source = overlay / ".claude" / "skills" / "gitnexus-plan" / "SKILL.md"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"x" * MAX_CANDIDATE_OVERLAY_BYTES)

    digest, payload = candidate_overlay_payload(overlay)
    assert candidate_overlay_digest(overlay) == digest

    frozen = tmp_path / "frozen"
    assert freeze_overlay(overlay, frozen) == digest
    assert candidate_overlay_payload(frozen) == (digest, payload)

    source.write_bytes(b"x" * (MAX_CANDIDATE_OVERLAY_BYTES + 1))
    with pytest.raises(ValueError, match="bounded evidence limit"):
        candidate_overlay_digest(overlay)

    rejected = tmp_path / "rejected"
    with pytest.raises(ValueError, match="bounded evidence limit"):
        freeze_overlay(overlay, rejected)
    assert not rejected.exists()


def test_apply_promoted_overlay_rejects_out_of_boundary_files(tmp_path):
    overlay = tmp_path / "overlay"
    rogue = overlay / ".claude" / "skills" / "not-a-family-skill" / "SKILL.md"
    rogue.parent.mkdir(parents=True)
    rogue.write_text("smuggled")

    with pytest.raises(ValueError, match="may only contain Markdown files"):
        apply_promoted_overlay(overlay, repo_root=tmp_path / "repo")
