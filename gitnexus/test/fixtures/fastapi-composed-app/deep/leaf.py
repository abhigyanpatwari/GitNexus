from fastapi import APIRouter

from .mid import MID

router = APIRouter()


@router.get(MID + "/leaf")
async def leaf():
    return {}
