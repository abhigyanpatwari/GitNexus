import models

def main():
    user = models.User("alice")
    user.save()
    user.greet()
