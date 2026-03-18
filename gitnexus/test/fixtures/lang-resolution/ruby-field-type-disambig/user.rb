require_relative 'address'

class User
  # @return [String]
  attr_accessor :name

  # @return [Address]
  attr_accessor :address

  def save
    true
  end
end
