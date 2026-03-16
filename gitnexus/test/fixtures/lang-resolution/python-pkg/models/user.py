from .base import BaseModel


class User(BaseModel):
    def get_name(self):
        return self.name
