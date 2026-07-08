from fastapi import APIRouter

from .constants import API_V1_WIDGETS_GET

router = APIRouter(prefix="/v2")


@router.post(API_V1_WIDGETS_GET)
async def create_widget_v2():
    return {"success": True}
