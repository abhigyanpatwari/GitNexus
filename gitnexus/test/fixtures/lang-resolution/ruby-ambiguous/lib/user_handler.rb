require_relative '../models/handler'

class UserHandler < Handler
  def handle_event
    process_request
  end
end
