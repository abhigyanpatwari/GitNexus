require_relative 'user'

# @param users [Array<User>]
def process_users(users)
  for user in users
    user.save
  end
end
