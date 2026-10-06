def caller_bound():
    from pkg.facade import target
    return target()


def caller_sibling():
    return target()
