class User
  def save
    true
  end
end

# @return [User]
def get_user(name)
  User.new
end

def process_user
  user = get_user("alice")
  user.save
end
