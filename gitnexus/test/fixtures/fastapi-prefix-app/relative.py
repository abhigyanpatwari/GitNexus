from fastapi import APIRouter

router = APIRouter()


@router.get("/info")
def info():
    return {}
