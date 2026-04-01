require_relative './formatter'

def run
  f = Formatter.new
  f.format("hello")
  f.format_with_prefix("hello", ">>")
end
