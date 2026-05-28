from fastapi import APIRouter

router = APIRouter()


@router.get("/list")
def list_users():
    return []


@router.post("/create")
def create_user(payload):
    return {"ok": True}
