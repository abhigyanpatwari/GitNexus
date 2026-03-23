from models import User, Address, City

def get_user() -> User:
    return User(Address(City("NYC")))

def process_chain():
    user = get_user()
    city = user.get_city()
    city.save()
