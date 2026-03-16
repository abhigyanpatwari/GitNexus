require_relative './user'

class UserService
  # @return [User]
  def get_user
    User.new
  end
end
