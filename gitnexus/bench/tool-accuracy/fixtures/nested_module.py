from pkg.facade import target


def outer_module():
    def target():
        return 2
    return target()


def caller_module():
    return target()
