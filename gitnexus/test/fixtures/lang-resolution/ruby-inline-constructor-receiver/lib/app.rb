require_relative 'svc'

def route_inline
  Service.new.do_work
end

def route_inline_args
  Service.new(1).do_work
end

def route_twostep
  s = Service.new
  s.do_work
end
