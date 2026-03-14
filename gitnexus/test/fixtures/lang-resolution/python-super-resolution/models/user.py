from .base import BaseModel

class User(BaseModel):
    def save(self) -> bool:
        super().save()
        return True
