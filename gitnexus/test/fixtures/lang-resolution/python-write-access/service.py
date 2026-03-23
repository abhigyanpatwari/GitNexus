from models import User, Address

def update_user(user: User):
    # Write access
    user.name = "Alice"
    user.address = Address()
