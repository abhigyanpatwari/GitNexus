class User:
    def __init__(self, name):
        self.name = name

    def save(self):
        return True

class Repo:
    def __init__(self, url):
        self.url = url

    def persist(self):
        return True
