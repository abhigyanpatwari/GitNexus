from fastapi import APIRouter

router = APIRouter()


@router.get("/list")
def list_calls():
    return []
