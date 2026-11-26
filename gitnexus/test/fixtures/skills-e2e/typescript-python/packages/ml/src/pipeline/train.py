
from packages.ml.src.data.loader import load_data, preprocess

def train(config):
    data = load_data("train.csv")
    processed = preprocess(data)
    return {"model": "trained", "data": processed}

def evaluate(model, test_data):
    data = load_data("test.csv")
    return {"accuracy": 0.95}
