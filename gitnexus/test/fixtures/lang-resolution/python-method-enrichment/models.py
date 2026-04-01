from abc import ABC, abstractmethod

class Animal(ABC):
    @abstractmethod
    def speak(self) -> str:
        pass

    @staticmethod
    def classify(name: str) -> str:
        return "mammal"

    def breathe(self) -> bool:
        return True

class Dog(Animal):
    def speak(self) -> str:
        return "woof"
