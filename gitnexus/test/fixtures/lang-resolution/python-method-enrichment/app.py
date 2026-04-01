from models import Dog

def main():
    dog = Dog()
    sound = dog.speak()
    category = Dog.classify("dog")
