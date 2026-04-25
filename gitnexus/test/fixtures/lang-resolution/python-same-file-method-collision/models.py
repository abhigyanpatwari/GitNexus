"""
Two classes in one file each defining a method with the same simple
name. Exercises the node-lookup qualified-name key — without it,
both User.save and Document.save share the bucket `models.py::save`
and every `document.save()` CALLS edge silently resolves to User.save.
"""


class User:
    def save(self) -> bool:
        return True

    def load(self) -> None:
        return None


class Document:
    def save(self) -> bool:
        return False

    def load(self) -> None:
        return None
