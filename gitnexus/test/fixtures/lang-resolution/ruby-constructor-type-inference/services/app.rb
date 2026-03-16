require_relative '../models/user'
require_relative '../models/repo'

class AppService
  def process_entities
    user = User.new
    repo = Repo.new
    user.save
    repo.save
  end

  def cleanup
    true
  end

  def greet
    self.process_entities
    self.cleanup
  end
end
