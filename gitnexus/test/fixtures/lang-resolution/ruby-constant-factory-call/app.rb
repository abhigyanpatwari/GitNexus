require_relative 'user_service'
require_relative 'admin_service'

# @return [UserService]
def build_service
  UserService.new
end

SERVICE = build_service()
SERVICE.process
SERVICE.validate
