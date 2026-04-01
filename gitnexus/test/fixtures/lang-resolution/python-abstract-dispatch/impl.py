from base import Repository

class SqlRepository(Repository):
    def find(self, id: int) -> dict:
        return {"id": id}

    def save(self, entity: dict) -> bool:
        return True
