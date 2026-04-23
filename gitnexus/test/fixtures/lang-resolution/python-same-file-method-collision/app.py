from models import User, Document


def use_user() -> None:
    u = User()
    u.save()


def use_document() -> None:
    d = Document()
    d.save()
