require_relative 'models/user_service'

svc = Models::UserService.new
svc.process('alice')
svc.validate
