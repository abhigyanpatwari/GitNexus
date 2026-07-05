from fastapi import APIRouter

router = APIRouter(prefix="/root-users")


@router.get("/landing")
def root_users_landing():
    return {}
