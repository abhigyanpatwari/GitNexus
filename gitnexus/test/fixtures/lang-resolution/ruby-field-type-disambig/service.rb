require_relative 'user'

# @param user [User]
def process_user(user)
  # Field-access chain: user.address → Address, then .save → Address#save
  # Both User and Address have save — only lookupFieldByOwner can disambiguate.
  user.address.save
end
