from fastapi import APIRouter

router = APIRouter()

@router.get("/agents")
async def list_agents():
    return []
