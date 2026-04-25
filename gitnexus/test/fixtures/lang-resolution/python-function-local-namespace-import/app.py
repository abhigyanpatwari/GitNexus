def outer() -> None:
    # Function-local namespace import — pythonImportOwningScope pins
    # `s` (alias for svc) to outer's Function scope. Receiver-bound
    # dispatch for `s.call()` must discover the namespace target
    # through a scope-chain walk, not only at module scope.
    import svc as s

    s.call()


def sanity() -> int:
    # Pure free call with no local import — guards against Unit 2's
    # scope-walk breaking vanilla resolution paths.
    return 1
