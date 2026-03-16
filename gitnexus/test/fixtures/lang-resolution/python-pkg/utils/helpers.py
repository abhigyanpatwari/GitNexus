from ..models.base import BaseModel


def process_model(model: BaseModel):
    model.validate()
    model.save()
