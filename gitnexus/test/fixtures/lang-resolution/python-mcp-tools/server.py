from mcp import tool

def _format_weather(city: str) -> str:
    return f"Weather in {city}: sunny"

def _lookup_weather(city: str) -> str:
    return _format_weather(city)

def _rank_docs(query: str) -> list:
    return [query]

def _lookup_docs(query: str) -> list:
    return _rank_docs(query)

@mcp.tool()
def get_weather(city: str) -> str:
    """Get weather for a city."""
    return _lookup_weather(city)

@mcp.tool()
def search_docs(query: str) -> list:
    """Search documentation."""
    return _lookup_docs(query)

@mcp.tool("Explicit description")
def explicit_tool() -> str:
    """Docstring that should not be used."""
    return "explicit"
