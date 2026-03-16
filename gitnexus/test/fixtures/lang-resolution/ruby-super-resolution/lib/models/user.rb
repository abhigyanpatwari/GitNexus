require_relative 'base_model'

class User < BaseModel
  def save
    super
    true
  end
end
