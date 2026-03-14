require_relative './base_model'
require_relative './concerns/serializable'

class User < BaseModel
  include Serializable

  attr_reader :name
  attr_writer :email

  def greet_user
    persist
    serialize_data
  end
end
