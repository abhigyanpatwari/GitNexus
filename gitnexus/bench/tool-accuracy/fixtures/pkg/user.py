from pkg import facade


def _pc():
    from pkg import facade
    return facade


def direct_caller():
    facade.target()


def lazy_chain():
    _pc().target()


def lazy_local():
    m = _pc()
    m.target()
