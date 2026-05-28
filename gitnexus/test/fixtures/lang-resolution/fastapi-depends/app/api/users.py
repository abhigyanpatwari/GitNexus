from fastapi import Depends, APIRouter
from app.dependencies import get_current_user_record, get_db, User, Session

router = APIRouter()


@router.get("/users")
async def get_user(user: User = Depends(get_current_user_record)):
    return user


@router.post("/users")
async def create_user(db=Depends(get_db)):
    return {}
