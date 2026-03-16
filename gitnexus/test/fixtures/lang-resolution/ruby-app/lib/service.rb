require_relative './user'

class UserService
  def create_user
    user = User.new
    user.persist
    user.greet_user
  end
end
