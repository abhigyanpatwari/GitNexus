require_relative 'models'

class Factory
  def run
    "FACTORY-RUN"
  end

  # An INSTANCE method named `new` — legal Ruby, and NOT construction.
  def new
    Product.new
  end
end

class Annotated
  def run
    "ANNOTATED-RUN"
  end

  # A class-level `new` override with a recorded return type.
  # @return [Widget]
  def self.new(*args)
    Widget.new
  end
end
