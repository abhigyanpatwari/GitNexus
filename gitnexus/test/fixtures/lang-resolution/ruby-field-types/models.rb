class Address
  # @return [String]
  attr_accessor :city

  def save
    true
  end
end

class User
  # @return [String]
  attr_accessor :name

  # @return [Address]
  attr_accessor :address

  def greet
    name
  end
end
