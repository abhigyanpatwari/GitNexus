require_relative './user'

class App
  def process_user
    user = User.new
    user.persist_record
  end
end
