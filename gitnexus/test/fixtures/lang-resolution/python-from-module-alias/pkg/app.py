from pkg import models
from pkg.models import User


def inline_save(db):
    return models.User(db).save()


def assigned_save(db):
    user = models.User(db)
    return user.save()


def direct_save(db):
    return User(db).save()
