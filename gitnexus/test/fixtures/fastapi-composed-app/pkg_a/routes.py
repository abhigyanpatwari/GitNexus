from fastapi import APIRouter

from .constants import SHARED

router = APIRouter()


@router.get(SHARED)
async def handler_a():
    return {}
