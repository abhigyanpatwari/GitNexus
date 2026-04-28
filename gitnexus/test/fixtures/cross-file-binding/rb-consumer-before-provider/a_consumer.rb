require_relative 'models/b_user_factory'

def process
  user = UserFactory.get_user
  user.save
end
