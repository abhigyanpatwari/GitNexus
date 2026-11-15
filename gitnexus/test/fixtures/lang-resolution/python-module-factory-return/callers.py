import mod
import mod as rp
from mod import Other, untyped


def alias_call():
    x = rp.make()
    return x.m()


def module_call():
    x = mod.make()
    return x.m()


def inline_alias():
    return rp.make().m()


def class_through_alias():
    x = rp.C()
    return x.m()


def shadowed_namespace():
    rp = Other()
    x = rp.make()
    return x.m()


def untyped_alias():
    x = rp.untyped()
    return x.m()


def untyped_inline():
    return rp.untyped().m()


def untyped_named():
    x = untyped()
    return x.m()
