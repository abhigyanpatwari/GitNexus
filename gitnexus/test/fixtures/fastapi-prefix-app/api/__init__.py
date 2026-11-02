from fastapi import APIRouter
from .agents import router as agents_router
from .models import router as models_router

router = APIRouter()
router.include_router(agents_router)
router.include_router(models_router)
router.include_router(models_router, prefix="/v1")
