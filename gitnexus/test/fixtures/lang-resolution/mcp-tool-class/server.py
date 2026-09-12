"""`@mcp.tool()` applied to a CLASS rather than a function.

`pipeline-phases/tools.ts` hangs the HANDLES_TOOL edge off whatever node the
tool decorator sat on (`handlerNodeId`), so a class-decorated tool produces a
`Class -> Tool` edge. Every other tool fixture decorates a function or falls
back to the file, so `Function -> Tool` / `File -> Tool` are the only pairs
they exercise.
"""

from mcp import tool


def _render(payload: dict) -> str:
    return str(payload)


@mcp.tool()
class WeatherTool:
    """Class-based MCP tool."""

    def run(self, payload: dict) -> str:
        return _render(payload)
