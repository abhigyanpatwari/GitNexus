require_relative 'greetable'
require_relative 'logger_mixin'
require_relative 'prepended_override'

class Account
  include Greetable
  extend LoggerMixin
  prepend PrependedOverride

  def serialize
    "account"
  end

  def call_greet
    greet
  end

  def call_serialize
    serialize
  end

  def call_prepended_marker
    prepended_marker
  end
end
