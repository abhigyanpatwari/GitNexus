"""
Provider module for the function-local-import propagation test.
`get_user` returns a `User` instance; the importer calls
`u = get_user(); u.save()` from INSIDE a function body, so the
`from svc import get_user` binding lives on the function scope, not
the module scope.
"""


class User:
    def save(self) -> bool:
        return True


def get_user() -> User:
    return User()
