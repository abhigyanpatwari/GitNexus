from typing import Optional


class Session:
    pass


class User:
    id: int
    username: str


async def get_db() -> Session:
    db = Session()
    try:
        yield db
    finally:
        pass


async def get_current_user_record(db: Session) -> User:
    return User()
