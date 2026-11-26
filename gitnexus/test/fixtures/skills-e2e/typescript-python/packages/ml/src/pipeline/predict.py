
from packages.ml.src.models.model import load_model

def predict(input_data):
    model = load_model("latest")
    return {"prediction": "result"}

def batch_predict(inputs):
    model = load_model("latest")
    return [{"prediction": "result"} for _ in inputs]
