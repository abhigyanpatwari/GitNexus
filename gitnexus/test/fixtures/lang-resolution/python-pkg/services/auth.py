from ..models.user import User


class AuthService:
    def authenticate(self, user: User):
        user.validate()
        return True
