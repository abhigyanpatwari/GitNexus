require 'lib/concerns/serializable'

class BaseModel
  attr_accessor :id, :created_at

  def persist
    run_validations
  end

  def run_validations
    true
  end

  def self.factory
    run_validations
  end
end
