from user import User

def process_user(user: User):
    # Field-access chain: user.address → Address, then .save() must resolve
    # to Address#save (NOT User#save) — only lookupFieldByOwner can disambiguate.
    user.address.save()
