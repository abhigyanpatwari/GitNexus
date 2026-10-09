"""The execution gate must reject absent, skipped, failed, or ambiguous evidence."""

from pathlib import Path
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

from check_test_execution import reconcile


def receipt(tmp_path: Path, filename: str, cases: list[tuple[str, str]], module="tests.test_native") -> Path:
    suite = ET.Element("testsuite", tests=str(len(cases)), failures="0", errors="0", skipped="0", time="1.5")
    for name, status in cases:
        case = ET.SubElement(suite, "testcase", classname=module, name=name)
        if status != "passed":
            ET.SubElement(case, status)
            count = {"failure": "failures", "error": "errors", "skipped": "skipped"}[status]
            suite.set(count, str(int(suite.get(count)) + 1))
    path = tmp_path / filename
    ET.ElementTree(suite).write(path, encoding="utf-8")
    return path


def test_platform_skip_requires_a_matching_real_pass(tmp_path):
    linux = receipt(tmp_path, "linux.xml", [("test_windows", "skipped"), ("test_posix", "passed")])
    windows = receipt(tmp_path, "windows.xml", [("test_windows", "passed"), ("test_posix", "skipped")])
    report = reconcile([linux, windows], ["tests/test_native.py"])
    assert report["success"] is True
    assert report["numPassedTests"] == report["numTotalTests"] == 2
    assert report["numPendingTests"] == report["numFailedTests"] == 0


def test_unresolved_skip_is_not_a_pass(tmp_path):
    path = receipt(tmp_path, "report.xml", [("test_missing_runtime", "skipped")])
    report = reconcile([path], [])
    assert report["success"] is False
    assert report["numPendingTests"] == 1
    assert report["numPassedTests"] == 0
    assert report["testResults"][0]["assertionResults"][0]["ancestorTitles"] == ["tests.test_native"]


@pytest.mark.parametrize("status", ["failure", "error"])
def test_failure_is_not_hidden_by_another_job_passing(tmp_path, status):
    failed = receipt(tmp_path, "failed.xml", [("test_shared", status)])
    passed = receipt(tmp_path, "passed.xml", [("test_shared", "passed")])
    report = reconcile([failed, passed], [])
    assert report["success"] is False
    assert report["numFailedTests"] == 1
    assert report["numPassedTests"] == 0
    assert report["executionFailures"] == ["tests.test_native::test_shared"]


def test_same_title_in_another_file_does_not_resolve_a_skip(tmp_path):
    pending = receipt(tmp_path, "pending.xml", [("test_same", "skipped")])
    unrelated = receipt(tmp_path, "unrelated.xml", [("test_same", "passed")], module="tests.test_other")
    report = reconcile([pending, unrelated], [])
    assert report["numTotalTests"] == 2
    assert report["numPendingTests"] == 1


def test_duplicate_identity_is_rejected(tmp_path):
    path = receipt(tmp_path, "duplicate.xml", [("test_same", "passed"), ("test_same", "skipped")])
    with pytest.raises(ValueError, match="ambiguous pytest identity"):
        reconcile([path], [])


def test_missing_receipt_is_rejected(tmp_path):
    with pytest.raises(FileNotFoundError):
        reconcile([tmp_path / "missing.xml"], [])


def test_empty_receipt_is_rejected(tmp_path):
    path = receipt(tmp_path, "empty.xml", [])
    with pytest.raises(ValueError, match="Empty pytest suite"):
        reconcile([path], [])


def test_missing_file_is_rejected(tmp_path):
    path = receipt(tmp_path, "report.xml", [("test_present", "passed")])
    with pytest.raises(ValueError, match="never collected: tests/test_missing.py"):
        reconcile([path], ["tests/test_missing.py"])


def test_inconsistent_counts_are_rejected(tmp_path):
    path = receipt(tmp_path, "report.xml", [("test_present", "passed")])
    path.write_text(path.read_text().replace('tests="1"', 'tests="2"'))
    with pytest.raises(ValueError, match="Inconsistent pytest tests count"):
        reconcile([path], [])


def test_pytest_testsuites_wrapper_and_test_classes(tmp_path):
    path = receipt(tmp_path, "report.xml", [("test_method", "passed")], module="tests.test_native.TestNative")
    suite = ET.parse(path).getroot()
    root = ET.Element("testsuites")
    root.append(suite)
    ET.ElementTree(root).write(path, encoding="utf-8")
    assert reconcile([path], ["tests/test_native.py"])["success"] is True


def test_missing_report_list_is_rejected():
    with pytest.raises(ValueError, match="No pytest execution reports"):
        reconcile([], [])


@pytest.mark.parametrize("scenario", ["passed", "pending", "failed", "missing-receipt", "missing-file"])
def test_cli_requires_complete_execution_evidence(tmp_path, scenario):
    script = tmp_path / "check_test_execution.py"
    shutil.copyfile(Path(__file__).parents[1] / script.name, script)
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_native.py").write_text("# inventory fixture\n")
    reports = tmp_path / "reports"
    reports.mkdir()
    receipt(reports, "pytest-locked.xml", [("test_native", "skipped" if scenario == "pending" else "passed")])
    receipt(reports, "pytest-ubuntu.xml", [("test_native", "error" if scenario == "failed" else "skipped")])
    if scenario != "missing-receipt":
        receipt(reports, "pytest-windows.xml", [("test_native", "skipped")])
    if scenario == "missing-file":
        (tests / "test_missing.py").write_text("# must be collected\n")
    output = tmp_path / "pytest-results.json"
    result = subprocess.run(
        [sys.executable, str(script), str(reports), str(output)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == (0 if scenario == "passed" else 1)
    if scenario.startswith("missing-"):
        assert not output.exists()
        assert ("pytest-windows.xml" if scenario == "missing-receipt" else "never collected") in result.stderr
    else:
        report = json.loads(output.read_text())
        assert report["success"] is (scenario == "passed")
        assert report["numTotalTests"] == 1
        assert report["numPassedTests"] == (scenario == "passed")
        assert report["numPendingTests"] == (scenario == "pending")
        assert report["numFailedTests"] == (scenario == "failed")
        assert "Eval execution:" in result.stdout
