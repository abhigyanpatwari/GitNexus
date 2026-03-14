require_relative './one_arg'
require_relative './two_args'

class Service
  def run_task
    write_audit("done")
  end
end
