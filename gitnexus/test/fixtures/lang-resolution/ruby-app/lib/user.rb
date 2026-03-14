require_relative './base_model'
require_relative './concerns/serializable'
require_relative './concerns/loggable'
require_relative './concerns/cacheable'

class User < BaseModel
  include Serializable
  extend Loggable
  prepend Cacheable

  attr_reader :name
  attr_writer :email

  def greet_user
    persist
    serialize_data
  end
end
