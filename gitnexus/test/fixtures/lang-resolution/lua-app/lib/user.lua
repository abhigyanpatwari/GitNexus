local User = {}
User.__index = User

function User.new(name, email)
	local self = setmetatable({}, User)
	self.name = name
	self.email = email
	return self
end

function User:greet()
	return "Hello, " .. self.name
end

function User:get_email()
	return self.email
end

return User
