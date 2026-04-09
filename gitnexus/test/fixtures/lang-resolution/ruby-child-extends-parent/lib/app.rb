require_relative 'child'

class App
  def run
    c = Child.new
    c.parent_method
  end
end
