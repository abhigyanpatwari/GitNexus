class City
  def save
    true
  end
end

class Address
  # @return [City]
  def get_city
    City.new
  end
end

class User
  # @return [Address]
  def get_address
    Address.new
  end
end

# @return [User]
def get_user
  User.new
end

def process_chain
  user = get_user()
  addr = user.get_address()
  city = addr.get_city()
  city.save
end
