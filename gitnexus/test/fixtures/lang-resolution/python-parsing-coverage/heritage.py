"""Heritage fixture — bare, qualified, and subscripted bases."""
from typing import Generic, TypeVar

T = TypeVar('T')

class BaseModel:
    pass

class Bare(BaseModel):
    pass

class Qualified(mod.BaseModel):
    pass

class Subscripted(Generic[T]):
    pass

class Both(mod.BaseModel, Generic[T]):
    pass
