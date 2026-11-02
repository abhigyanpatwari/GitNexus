from fastapi import APIRouter

router = APIRouter()

@router.get("/models")
async def list_models():
    return []
