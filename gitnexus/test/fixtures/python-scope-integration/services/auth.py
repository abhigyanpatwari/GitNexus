"""Auth service — exercises named imports, aliased imports, function-local imports."""
from models.user import User as UserModel
from utils.logger import log_info, log_error
import models.user


class AuthService:
    """Authenticates users."""

    def __init__(self):
        self.attempts = 0

    def authenticate(self, user: UserModel, token: str) -> bool:
        self.attempts += 1
        log_info("auth attempt")
        if not token:
            # Function-local import — should attach to the function scope,
            # not the module. Tests `pythonImportOwningScope`.
            from utils.logger import log_error as fail
            fail("no token")
            return False
        return True

    @classmethod
    def from_env(cls, env: dict) -> "AuthService":
        # @classmethod → cls receiver synthesized as `AuthService`.
        return cls()

    @staticmethod
    def hash_token(token: str) -> str:
        # @staticmethod → no implicit receiver; calls inside should NOT
        # carry a `self` typeBinding.
        return token.upper()
