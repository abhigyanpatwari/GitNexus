import mod


def use_class_attr() -> int:
    # Would silently bind to User.MAX_USERS without the fix.
    return mod.MAX_USERS


def use_helper() -> int:
    # Happy-path guard: legitimate top-level function export must still resolve.
    return mod.helper()
