from .base import BaseModel

class User(BaseModel):
    def serialize(self) -> str:
        return ''
