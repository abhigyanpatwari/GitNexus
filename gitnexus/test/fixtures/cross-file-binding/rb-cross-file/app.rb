require_relative 'models/user_factory'

def process
  user = UserFactory.get_user
  user.save
  user.get_name
end
