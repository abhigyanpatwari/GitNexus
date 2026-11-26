
def load_data(path):
    return {"path": path, "rows": []}

def preprocess(data):
    return {**data, "preprocessed": True}

def split_data(data, ratio=0.8):
    return data, data
