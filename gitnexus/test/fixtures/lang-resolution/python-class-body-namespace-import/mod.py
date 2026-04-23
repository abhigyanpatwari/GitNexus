"""
Provider module for the class-body namespace-import test.
`mod.helper` is reached via `mod.helper()` from inside a method of
a class that declares `import mod` in its class body.
"""


def helper() -> int:
    return 42
