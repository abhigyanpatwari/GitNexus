"""
Provider module for the function-local namespace-import test.
`svc.call` is a top-level function that the consumer reaches via
`s.call()` after `import svc as s` inside a function body.
"""


def call() -> None:
    return None
