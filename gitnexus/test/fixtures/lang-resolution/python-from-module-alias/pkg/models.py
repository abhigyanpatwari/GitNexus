class User:
    def __init__(self, db):
        self.db = db

    def save(self):
        return self.db
