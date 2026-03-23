require_relative 'user'

class UserFactory
  def self.get_user
    User.new
  end
end
