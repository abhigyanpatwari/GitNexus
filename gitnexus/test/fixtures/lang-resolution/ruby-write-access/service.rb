require_relative 'models'

class UserService
  def update_user
    user = User.new

    # Simple write (setter method call)
    user.name = "Alice"

    # Object write
    user.address = Address.new

    # Compound assignment (operator_assignment node)
    user.score += 10
  end
end
