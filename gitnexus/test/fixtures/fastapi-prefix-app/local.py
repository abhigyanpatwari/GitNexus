from fastapi import APIRouter

router = APIRouter(prefix="/local")


@router.get("")
def list_local():
    return []
