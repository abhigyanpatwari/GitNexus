from fastapi import APIRouter, Depends


def get_db():
    return None


# Router-level dependency listed BEFORE `prefix=` — exercises the
# balanced-paren scan end-to-end. The old `[^)]*?` regex stopped at the
# `)` of `Depends(...)` and dropped the prefix, leaving the Route node
# unprefixed; this route must still resolve to `/v1/items/{item_id}`.
router = APIRouter(dependencies=[Depends(get_db)], prefix="/items")


@router.get("/{item_id}")
def get_item(item_id: str):
    return {"id": item_id}
