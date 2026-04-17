require_relative 'account'

class Usage
  def run
    a = Account.new
    a.call_greet
    a.call_serialize
    Account.log("from Usage")
  end
end
