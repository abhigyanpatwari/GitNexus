from abc import ABC, abstractmethod

class Repository(ABC):
    @abstractmethod
    def find(self, id: int) -> dict:
        pass

    @abstractmethod
    def save(self, entity: dict) -> bool:
        pass
