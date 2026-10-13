module Labels
  attr_reader :module_label
end

class Base
  attr_accessor :inherited

  def slot
    1
  end
end

class Child < Base
  include Labels
  attr_accessor :name, :slot
  attr_writer :write_only

  class << self
    attr_reader :class_name
  end

  def instance_access
    self.name
    self.inherited
    self.class_name
  end

  def self.class_access
    self.class_name
    self.name
  end
end
