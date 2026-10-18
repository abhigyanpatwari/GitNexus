def outer():
    def target():
        return 2
    return target()


def caller_local():
    from pkg.facade import target
    return target()


def caller_unbound():
    return target()
