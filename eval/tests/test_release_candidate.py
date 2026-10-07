"""Release candidates must survive a job boundary without changing their identity."""

import json
import subprocess
from pathlib import Path

import pytest

from workflow_bench.release_candidate import create_bundle, restore_bundle


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


@pytest.fixture
def candidate(tmp_path):
    repo = tmp_path / "source"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Release Test")
    git(repo, "config", "user.email", "release@example.invalid")
    (repo / "gitnexus").mkdir()
    package = repo / "gitnexus/package.json"
    package.write_text(json.dumps({"name": "gitnexus", "version": "1.0.0"}))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "source")
    parent = git(repo, "rev-parse", "HEAD")
    consumer = tmp_path / "consumer"
    subprocess.run(["git", "clone", "-q", str(repo), str(consumer)], check=True)
    git(repo, "checkout", "--detach", "-q")
    package.write_text(json.dumps({"name": "gitnexus", "version": "1.0.1-rc.1"}))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "release: v1.0.1-rc.1")
    sha = git(repo, "rev-parse", "HEAD")
    bundle = tmp_path / "candidate.bundle"
    return repo, consumer, parent, sha, bundle


def test_roundtrip_preserves_versioned_tree_and_parent_without_remote_refs(candidate):
    repo, consumer, parent, sha, bundle = candidate
    assert create_bundle(repo, parent, "1.0.1-rc.1", bundle) == sha
    assert git(repo, "tag", "--list") == ""
    assert git(repo, "branch", "--list", "release-candidate") == ""
    assert restore_bundle(consumer, parent, sha, bundle, "1.0.1-rc.1") == sha
    assert git(consumer, "rev-parse", "HEAD^{tree}") == git(repo, "rev-parse", "HEAD^{tree}")
    assert git(consumer, "rev-parse", "HEAD^") == parent
    assert git(consumer, "rev-parse", "--abbrev-ref", "HEAD") == "HEAD"


@pytest.mark.parametrize("field", ["sha", "parent", "version"])
def test_restore_rejects_mismatched_gate_identity(candidate, field):
    repo, consumer, parent, sha, bundle = candidate
    create_bundle(repo, parent, "1.0.1-rc.1", bundle)
    with pytest.raises(ValueError):
        restore_bundle(
            consumer,
            sha if field == "parent" else parent,
            parent if field == "sha" else sha,
            bundle,
            "1.0.2-rc.1" if field == "version" else "1.0.1-rc.1",
        )
    assert git(consumer, "rev-parse", "HEAD") == parent


def test_corrupted_bundle_cannot_be_restored(candidate):
    repo, consumer, parent, sha, bundle = candidate
    create_bundle(repo, parent, "1.0.1-rc.1", bundle)
    bundle.write_bytes(bundle.read_bytes()[:80])
    with pytest.raises((ValueError, subprocess.CalledProcessError)):
        restore_bundle(consumer, parent, sha, bundle)
    assert git(consumer, "rev-parse", "HEAD") == parent


@pytest.mark.parametrize("dirty", [False, True])
def test_bundle_requires_exact_version_and_clean_tree(candidate, dirty):
    repo, _, parent, _, bundle = candidate
    if dirty:
        (repo / "gitnexus/package.json").write_text("uncommitted")
    with pytest.raises(ValueError):
        create_bundle(repo, parent, "1.0.1-rc.1" if dirty else "1.0.2-rc.1", bundle)
    assert not bundle.exists()


def test_bundle_cannot_have_an_extra_release_commit(candidate):
    repo, _, parent, _, bundle = candidate
    git(repo, "commit", "--allow-empty", "-qm", "unexpected second commit")
    with pytest.raises(ValueError, match="parent"):
        create_bundle(repo, parent, "1.0.1-rc.1", bundle)


def test_bundle_must_export_only_the_candidate_ref(candidate):
    repo, consumer, parent, sha, bundle = candidate
    git(repo, "branch", "release-candidate", sha)
    git(repo, "branch", "extra", sha)
    git(repo, "bundle", "create", str(bundle), "release-candidate", "extra", f"^{parent}")
    with pytest.raises(ValueError, match="single"):
        restore_bundle(consumer, parent, sha, bundle)
