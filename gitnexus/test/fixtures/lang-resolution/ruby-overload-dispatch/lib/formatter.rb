class Formatter
  def format(value)
    value.upcase
  end

  def format_with_prefix(value, prefix)
    prefix + value.upcase
  end
end
