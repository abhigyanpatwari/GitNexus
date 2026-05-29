from fastapi import APIRouter

# Same module name as `api/users.py`. Before the long-key fix the
# basename `users` collided across packages, leaking `/users` (the
# prefix mounted on `api/users.py`) onto these admin routes.
# parse-impl now keys prefixes by `<dir>/<stem>` whenever the import
# statement carried enough context, so this file's `@router.get`
# routes must NOT be prefixed with `/users`.
router = APIRouter()


@router.get("/audit")
def audit():
    return []
