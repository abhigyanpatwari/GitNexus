"""Tests for MCPBridge._find_gitnexus_command() and subprocess spawn."""
import subprocess
import unittest
from unittest.mock import MagicMock, call, patch


class TestFindGitnexusCommand(unittest.TestCase):
    """Verify _find_gitnexus_command() returns the correct command prefix."""

    def _make_bridge(self):
        from bridge.mcp_bridge import MCPBridge
        return MCPBridge(repo_path="/fake/repo")

    def _success(self):
        r = MagicMock()
        r.returncode = 0
        return r

    def _failure(self):
        r = MagicMock()
        r.returncode = 1
        return r

    def test_npx_path_returns_npx_gitnexus(self):
        """When npx probe succeeds, command prefix is ['npx', 'gitnexus']."""
        with patch("subprocess.run", return_value=self._success()) as mock_run:
            bridge = self._make_bridge()
            result = bridge._find_gitnexus_command()

        self.assertEqual(result, ["npx", "gitnexus"])
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        self.assertEqual(args, ["npx", "gitnexus", "--version"])

    def test_global_path_returns_gitnexus(self):
        """When npx probe fails but global install exists, prefix is ['gitnexus']."""
        with patch("subprocess.run", side_effect=[self._failure(), self._success()]) as mock_run:
            bridge = self._make_bridge()
            result = bridge._find_gitnexus_command()

        self.assertEqual(result, ["gitnexus"])
        self.assertEqual(mock_run.call_count, 2)

    def test_both_fail_returns_none(self):
        """When both probes fail, returns None."""
        with patch("subprocess.run", return_value=self._failure()):
            bridge = self._make_bridge()
            result = bridge._find_gitnexus_command()

        self.assertIsNone(result)

    def test_npx_exception_falls_back_to_global(self):
        """When npx raises (not installed), falls back to global probe."""
        with patch("subprocess.run", side_effect=[FileNotFoundError, self._success()]):
            bridge = self._make_bridge()
            result = bridge._find_gitnexus_command()

        self.assertEqual(result, ["gitnexus"])

    def test_both_raise_returns_none(self):
        """When both probes raise exceptions, returns None."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            bridge = self._make_bridge()
            result = bridge._find_gitnexus_command()

        self.assertIsNone(result)

    def test_stdin_devnull_on_npx_probe(self):
        """npx probe must pass stdin=DEVNULL to prevent interactive blocking."""
        with patch("subprocess.run", return_value=self._success()) as mock_run:
            bridge = self._make_bridge()
            bridge._find_gitnexus_command()

        kwargs = mock_run.call_args[1]
        self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)

    def test_stdin_devnull_on_global_probe(self):
        """global probe must pass stdin=DEVNULL to prevent interactive blocking."""
        with patch("subprocess.run", side_effect=[self._failure(), self._success()]) as mock_run:
            bridge = self._make_bridge()
            bridge._find_gitnexus_command()

        global_call_kwargs = mock_run.call_args_list[1][1]
        self.assertEqual(global_call_kwargs.get("stdin"), subprocess.DEVNULL)


class TestStartSpawnCommand(unittest.TestCase):
    """Verify start() spawns Popen with the correct argv."""

    def _make_bridge(self):
        from bridge.mcp_bridge import MCPBridge
        return MCPBridge(repo_path="/fake/repo")

    def test_npx_path_spawns_npx_gitnexus_mcp(self):
        """When npx path found, Popen must receive ['npx', 'gitnexus', 'mcp']."""
        bridge = self._make_bridge()

        with patch.object(bridge, "_find_gitnexus_command", return_value=["npx", "gitnexus"]), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(bridge, "_send_request", return_value={"protocolVersion": "2024-11-05"}), \
             patch.object(bridge, "_send_notification"):

            mock_proc = MagicMock()
            mock_proc.stdin = MagicMock()
            mock_proc.stdout = MagicMock()
            mock_proc.stderr = MagicMock()
            mock_popen.return_value = mock_proc

            bridge.start()

        mock_popen.assert_called_once()
        argv = mock_popen.call_args[0][0]
        self.assertEqual(argv, ["npx", "gitnexus", "mcp"])

    def test_global_path_spawns_gitnexus_mcp(self):
        """When global path found, Popen must receive ['gitnexus', 'mcp']."""
        bridge = self._make_bridge()

        with patch.object(bridge, "_find_gitnexus_command", return_value=["gitnexus"]), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(bridge, "_send_request", return_value={"protocolVersion": "2024-11-05"}), \
             patch.object(bridge, "_send_notification"):

            mock_proc = MagicMock()
            mock_proc.stdin = MagicMock()
            mock_proc.stdout = MagicMock()
            mock_proc.stderr = MagicMock()
            mock_popen.return_value = mock_proc

            bridge.start()

        mock_popen.assert_called_once()
        argv = mock_popen.call_args[0][0]
        self.assertEqual(argv, ["gitnexus", "mcp"])

    def test_no_shell_true(self):
        """Popen must never be called with shell=True."""
        bridge = self._make_bridge()

        with patch.object(bridge, "_find_gitnexus_command", return_value=["npx", "gitnexus"]), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(bridge, "_send_request", return_value={"protocolVersion": "2024-11-05"}), \
             patch.object(bridge, "_send_notification"):

            mock_proc = MagicMock()
            mock_proc.stdin = MagicMock()
            mock_proc.stdout = MagicMock()
            mock_proc.stderr = MagicMock()
            mock_popen.return_value = mock_proc

            bridge.start()

        kwargs = mock_popen.call_args[1]
        self.assertNotEqual(kwargs.get("shell"), True)

    def test_gitnexus_not_found_returns_false(self):
        """start() returns False and does not call Popen when gitnexus not found."""
        bridge = self._make_bridge()

        with patch.object(bridge, "_find_gitnexus_command", return_value=None), \
             patch("subprocess.Popen") as mock_popen:

            result = bridge.start()

        self.assertFalse(result)
        mock_popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
