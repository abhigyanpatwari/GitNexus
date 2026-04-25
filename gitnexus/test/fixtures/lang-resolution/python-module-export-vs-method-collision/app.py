import mod
from mod import User


def use_module_export() -> None:
    mod.save(1)


def use_method() -> None:
    u = User()
    u.save()
