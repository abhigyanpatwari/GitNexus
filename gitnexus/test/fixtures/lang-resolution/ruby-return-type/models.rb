class User
  def initialize(name)
    @name = name
  end

  def save
    true
  end
end

# @return [User]
def get_user(name)
  User.new(name)
end
