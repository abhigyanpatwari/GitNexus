import mod as rp
from mod import make


def control():
    x = make()
    return x.m()


def conditional(flag):
    x = make() if flag else None
    if x is not None:
        return x.m()


def qualified():
    x = rp.make()
    return x.m()


def boolean():
    x = make() or None
    if x is not None:
        return x.m()
