from user import User
from typing import List


def process_users(users: dict[str, User]):
    # 3-variable enumerate: i=index, k=key, v=value (User)
    for i, k, v in enumerate(users.items()):
        v.save()


def process_nested_tuple(users: dict[str, User]):
    # Nested tuple pattern: i=index, (k,v) tuple unpacked
    for i, (k, v) in enumerate(users.items()):
        v.save()


def process_parenthesized_tuple(users: List[User]):
    # Parenthesized tuple as top-level pattern
    for (i, u) in enumerate(users):
        u.save()
