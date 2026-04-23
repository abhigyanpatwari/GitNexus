class A:
    # Class-body namespace import — `mod` binds to A's Class scope
    # per pythonImportOwningScope. Receiver-bound dispatch for
    # `mod.helper()` inside A.use must walk the scope chain up to
    # the class scope to discover the namespace target.
    import mod

    def use(self) -> int:
        return mod.helper()
