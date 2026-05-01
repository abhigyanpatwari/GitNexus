local Service = require("lib.service")

local function main()
	local svc = Service.new()
	local user = svc:create_user("Alice", "alice@example.com")
	svc:process(user)
end

main()
