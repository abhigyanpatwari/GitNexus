from fastapi import FastAPI
from api import users
from api.calls import router as calls_router
from .relative import router as rel_router

# Hostname is `application`, NOT `app` — exercises the unrestricted-host
# path through both the parse-worker regex and the group-layer
# tree-sitter pattern. Pinning to literal `app` would silently drop
# every prefix here.
application = FastAPI()
application.include_router(users.router, prefix="/users", tags=["users"])
application.include_router(calls_router, prefix="/calls")
application.include_router(rel_router, prefix="/rel")
