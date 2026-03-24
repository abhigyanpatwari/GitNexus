"""
MCP Bridge for GitNexus

Starts the GitNexus MCP server as a subprocess and provides a Python interface
to call MCP tools. Used by the bash wrapper scripts and the augmentation layer..

The bridge communicates with the MCP server via stdio using the JSON-RPC protocol.
"""

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("mcp_bridge")


class MCPBridge:
    """
    Manages a GitNexus MCP server subprocess and proxies tool calls to it.
    
    Usage:
        bridge = MCPBridge(repo_path="/path/to/repo")
        bridge.start()
        result = bridge.call_tool("query", {"query": "authentication"})
        bridge.stop()
    """

    def __init__(self, repo_path: str | None = None):
        self.repo_path = repo_path or os.getcwd()
        self.process: subprocess.Popen | None = None
        self._request_id = 0
        self._lock = threading.Lock()
        self._started = False

    def start(self) -> bool:
        """Start the GitNexus MCP server subprocess."""
        if self._started:
            return True

        try:
            # Find gitnexus binary
            gitnexus_bin = self._find_gitnexus()
            if not gitnexus_bin:
                logger.error("GitNexus not found. Install with: npm install -g gitnexus")
                return False

            self.process = subprocess.Popen(
                [gitnexus_bin, "mcp"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.repo_path,
                text=False,
            )

            # Send initialize request
            init_result = self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "gitnexus-eval", "version": "0.1.0"},
            })

            if init_result is None:
                logger.error("MCP server failed to initialize")
                self.stop()
                return False

            # Send initialized notification
            self._send_notification("notifications/initialized", {})
            self._started = True
            logger.info("MCP bridge started successfully")
            return True

        except Exception as e:
            logger.error(f"Failed to start MCP bridge: {e}")
            self.stop()
            return False

    def stop(self):
        """Stop the MCP server subprocess."""
        if self.process:
            try:
                self.process.stdin.close()
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None
        self._started = False

    def call_tool(self, tool_name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """
        Call a GitNexus MCP tool and return the result.
        
        Returns the tool result content or None on error.
        """
        if not self._started:
            logger.error("MCP bridge not started")
            return None

        result = self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments or {},
        })

        if result is None:
            return None

        # Extract text content from MCP response
        content = result.get("content", [])
        if content and isinstance(content, list):
            texts = [item.get("text", "") for item in content if item.get("type") == "text"]
            return {"text": "\n".join(texts), "raw": content}

        return {"text": "", "raw": content}

    def list_tools(self) -> list[dict]:
        """List available MCP tools."""
        result = self._send_request("tools/list", {})
        if result:
            return result.get("tools", [])
        return []

    def read_resource(self, uri: str) -> str | None:
        """Read an MCP resource by URI."""
        result = self._send_request("resources/read", {"uri": uri})
        if result:
            contents = result.get("contents", [])
            if contents:
                return contents[0].get("text", "")
        return None

    def _find_gitnexus(self) -> str | None:
        """Find the gitnexus CLI binary."""
        # Check if npx is available (preferred - uses local install)
        for cmd in ["npx"]:
            try:
                result = subprocess.run(
                    [cmd, "gitnexus", "--version"],
                    capture_output=True, text=True, timeout=15,
                    cwd=self.repo_path,
                )
                if result.returncode == 0:
                    return cmd  # Will use "npx gitnexus mcp"
            except Exception:
                continue

        # Check for global install
        try:
            result = subprocess.run(
                ["gitnexus", "--version"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                return "gitnexus"
        except Exception:
            pass

        return None

    def _next_id(self) -> int:
        with self._lock:
            self._request_id += 1
            return self._request_id

    def _send_request(self, method: str, params: dict) -> dict | None:
        """Send a JSON-RPC request and wait for response."""
        if not self.process or not self.process.stdin or not self.process.stdout:
            return None

        request_id = self._next_id()
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }

        try:
            message = json.dumps(request)
            # MCP uses Content-Length header framing
            header = f"Content-Length: {len(message.encode('utf-8'))}\r\n\r\n"
            self.process.stdin.write(header.encode("utf-8"))
            self.process.stdin.write(message.encode("utf-8"))
            self.process.stdin.flush()

            # Read response
            response = self._read_response(timeout=30)
            if response and response.get("id") == request_id:
                if "error" in response:
                    logger.error(f"MCP error: {response['error']}")
                    return None
                return response.get("result")
            return None

        except Exception as e:
            logger.error(f"MCP request failed: {e}")
            return None

    def _send_notification(self, method: str, params: dict):
        """Send a JSON-RPC notification (no response expected)."""
        if not self.process or not self.process.stdin:
            return

        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }

        try:
            message = json.dumps(notification)
            header = f"Content-Length: {len(message.encode('utf-8'))}\r\n\r\n"
            self.process.stdin.write(header.encode("utf-8"))
            self.process.stdin.write(message.encode("utf-8"))
            self.process.stdin.flush()
        except Exception as e:
            logger.error(f"MCP notification failed: {e}")

    def _read_response(self, timeout: float = 30) -> dict | None:
        """Read a JSON-RPC response from the MCP server."""
        if not self.process or not self.process.stdout:
            return None

        start = time.time()

        try:
            while time.time() - start < timeout:
                # Read Content-Length header
                header_line = b""
                while True:
                    byte = self.process.stdout.read(1)
                    if not byte:
                        return None
                    header_line += byte
                    if header_line.endswith(b"\r\n\r\n"):
                        break
                    if header_line.endswith(b"\n\n"):
                        break

                # Parse content length
                header_str = header_line.decode("utf-8").strip()
                content_length = None
                for line in header_str.split("\r\n"):
                    if line.lower().startswith("content-length:"):
                        content_length = int(line.split(":")[1].strip())
                        break

                if content_length is None:
                    continue

                # Read body
                body = self.process.stdout.read(content_length)
                if not body:
                    return None

                message = json.loads(body.decode("utf-8"))

                # Skip notifications (no id), return responses
                if "id" in message:
                    return message

            return None

        except Exception as e:
            logger.error(f"Error reading MCP response: {e}")
            return None


class MCPToolCLI:
    """
    CLI wrapper that exposes MCP tools as simple command-line calls.
    Used by the bash wrapper scripts inside Docker containers.
    
    Usage from bash:
        python -m bridge.mcp_bridge query '{"query": "authentication"}'
        python -m bridge.mcp_bridge context '{"name": "validateUser"}'
    """

    def __init__(self):
        self.bridge = MCPBridge()

    def run(self, tool_name: str, args_json: str = "{}") -> int:
        """Run a single tool call and print the result."""
        try:
            args = json.loads(args_json)
        except json.JSONDecodeError:
            # Try to parse as simple key=value pairs
            args = self._parse_simple_args(args_json)

        if not self.bridge.start():
            print("ERROR: Failed to start GitNexus MCP bridge", file=sys.stderr)
            return 1

        try:
            result = self.bridge.call_tool(tool_name, args)
            if result:
                print(result.get("text", ""))
                return 0
            else:
                print("No results", file=sys.stderr)
                return 1
        finally:
            self.bridge.stop()

    @staticmethod
    def _parse_simple_args(args_str: str) -> dict:
        """Parse 'key=value key2=value2' style arguments."""
        args = {}
        for part in args_str.split():
            if "=" in part:
                key, value = part.split("=", 1)
                args[key] = value
        return args


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m bridge.mcp_bridge <tool_name> [args_json]", file=sys.stderr)
        print("Tools: query, context, impact, cypher, list_repos, detect_changes, rename", file=sys.stderr)
        sys.exit(1)

    tool = sys.argv[1]
    args_json = sys.argv[2] if len(sys.argv) > 2 else "{}"

    cli = MCPToolCLI()
    sys.exit(cli.run(tool, args_json))
