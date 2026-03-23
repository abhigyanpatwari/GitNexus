require_relative './user_service'

class App
  def process
    svc = UserService.new
    svc.get_user.save
  end
end
