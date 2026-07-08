from fastapi import FastAPI

from .constants import API_V1

app = FastAPI()

# #2393 source-order snapshot: SNAP captures API_V1's value at THIS line ("/api/v1").
# The later `API_V1 += "/mutated"` must not retroactively change SNAP's route.
SNAP = API_V1
API_V1 += "/mutated"


@app.get(SNAP)
async def snap_route():
    return {}
