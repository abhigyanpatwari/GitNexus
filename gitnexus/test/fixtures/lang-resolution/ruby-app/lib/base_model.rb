class BaseModel
  attr_accessor :id, :created_at

  def persist
    run_validations
  end

  def run_validations
    true
  end
end
