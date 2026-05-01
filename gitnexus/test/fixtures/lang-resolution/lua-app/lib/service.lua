local User = require("lib.user")

local Service = {}
Service.__index = Service

function Service.new()
	local self = setmetatable({}, Service)
	return self
end

function Service:create_user(name, email)
	local user = User.new(name, email)
	return user
end

function Service:process(user)
	local greeting = user:greet()
	print(greeting)
	return greeting
end

return Service
