require_relative 'models'

# @param user [User]
def process_user(user)
  # Field-access chain: user.address → Address, then .save → Address#save
  user.address.save
end
