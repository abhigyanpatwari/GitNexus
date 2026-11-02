require_relative 'model'

def read_attributes
  child = Child.new
  child.name
  child.inherited
  child.slot
  child.module_label
  child.class_name
  child.write_only
  Child.class_name
  Child.name
end

def write_attributes
  child = Child.new
  child.name = "ok"
  child.inherited = 1
end

def invalid_reader_arity
  child = Child.new
  child.name(1)
  child.slot(1)
end
