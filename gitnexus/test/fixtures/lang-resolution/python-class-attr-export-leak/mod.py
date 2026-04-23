"""
Class-body attribute (`User.MAX_USERS`) that MUST NOT leak into the
module's export index. `from mod import MAX_USERS` / `mod.MAX_USERS`
should find nothing — there is no top-level `MAX_USERS` at module
scope.

Also includes a top-level `def helper()` as a happy-path guard: the
narrowing fix must not over-narrow and drop legitimate module-level
function exports.
"""


class User:
    MAX_USERS = 100

    def save(self) -> bool:
        return True


def helper() -> int:
    return 42
