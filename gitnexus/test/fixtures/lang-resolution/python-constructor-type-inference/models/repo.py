class Repo:
    def __init__(self, db_name: str):
        self.db_name = db_name

    def save(self) -> bool:
        return False
