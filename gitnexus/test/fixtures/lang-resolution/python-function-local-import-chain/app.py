def do_work() -> bool:
    # Function-local import — pythonImportOwningScope pins `get_user`
    # to the function scope, not the module scope. The cross-file
    # return-type propagation pass must mirror the return type into
    # THIS scope's typeBindings, or `u.save()` misses its edge.
    from svc import get_user

    u = get_user()
    return u.save()
