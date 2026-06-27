from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.get("/{item_id}")
def get_item(item_id: str):
    return {"id": item_id}
