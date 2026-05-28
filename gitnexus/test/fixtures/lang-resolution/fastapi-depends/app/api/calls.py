from fastapi import Depends, APIRouter
from app.dependencies import get_current_user_record, get_db, User, Session

router = APIRouter()


@router.get("/calls")
async def list_calls(
    user: User = Depends(get_current_user_record),
    db: Session = Depends(get_db),
):
    return []
