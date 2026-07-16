from fastapi import APIRouter

from .constants import API_V1_WIDGETS_GET

router = APIRouter()


@router.post(API_V1_WIDGETS_GET)
async def create_widget():
    return {"success": True}


@router.get("/literal/health")
async def health():
    return {"ok": True}


@router.delete(UNKNOWN_ROUTE_CONST)
async def remove_widget():
    return {"deleted": True}
