"""FastAPI fixture for the route extractor test suite (Issues #79, #5, #78).

Covers:
  - the eight standard HTTP verbs (get/post/put/delete/patch/head/options/trace)
  - the `app.<verb>(...)` pattern
  - the `router.<verb>(...)` pattern (any receiver)
  - a non-route decorator (`@app.exception_handler`) that must be ignored
  - a non-route decorator (`@staticmethod`) that must be ignored
"""

from fastapi import FastAPI, APIRouter
from fastapi import WebSocket

app = FastAPI()
router = APIRouter()


@app.get("/users")
async def list_users():
    return []


@app.post("/users")
async def create_user(name: str):
    return {"name": name}


@app.put("/users/{id}")
async def update_user(id: int, name: str):
    return {"id": id, "name": name}


@app.delete("/users/{id}")
async def delete_user(id: int):
    return {"deleted": id}


@app.patch("/users/{id}")
async def patch_user(id: int):
    return {"id": id}


@app.head("/users")
async def head_users():
    return []


@app.options("/users")
async def options_users():
    return {}


@app.trace("/users")
async def trace_users():
    return {}


@router.get("/orders")
async def list_orders():
    return []


@router.post("/orders")
async def create_order():
    return {}


# These are NOT routes — they must be ignored by the extractor.
@app.exception_handler(Exception)
async def handle_exception(request, exc):
    return None


@staticmethod
def helper(x: int) -> int:
    return x + 1


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
