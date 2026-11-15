from models import User, make_other, make_user


def direct():
    user = make_user()
    user.save()


def conditional(flag):
    user = make_user() if flag else None
    if user is not None:
        user.save()


def reverse_conditional(flag):
    user = None if flag else make_user()
    if user is not None:
        user.save()


def or_none():
    user = make_user() or None
    if user is not None:
        user.save()


def none_or():
    user = None or make_user()
    if user is not None:
        user.save()


def class_constructor(flag):
    user = User() if flag else None
    if user is not None:
        user.save()


def two_factories(flag):
    user = make_user() if flag else make_other()
    user.save()


def and_none():
    user = make_user() and None
    user.save()


def or_other():
    user = make_user() or make_other()
    user.save()


def none_and():
    user = None and make_user()
    user.save()
