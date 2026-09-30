from fastapi import APIRouter

router = APIRouter()

@router.get("/model-audit")
async def audit_models():
    return []
