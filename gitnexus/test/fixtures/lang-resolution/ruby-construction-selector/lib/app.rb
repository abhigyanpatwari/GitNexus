require_relative 'factory'

# `Factory.new` is construction: the receiver is the class constant.
def via_class_constant
  Factory.new.run
end

# `factory.new` calls the INSTANCE method `new`, which returns a Product.
def via_instance
  factory = Factory.new
  factory.new.run
end

# `Annotated.new` has a recorded return type, which must win over the
# construction shortcut.
def via_annotated_return
  Annotated.new.run
end
