"""
Class method declared BEFORE a top-level function with the same
simple name. Order matters for the workspace-resolution-index bug:
without the module-scope filter, `User.save` enters
`defsByFileAndName[mod.py]['save']` first and wins first-seen. Then
`mod.save(x)` silently binds to `User.save` instead of the free
function — the exact wrong-edge symptom Codex flagged.

Assertions in the paired test pin the intended behavior: `mod.save`
resolves to the top-level Function, `u.save()` resolves to User.save
Method.
"""


class User:
    def save(self) -> bool:
        return True


def save(x: int) -> bool:
    return x > 0
