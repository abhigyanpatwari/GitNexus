require_relative "source"
def build
  Source::Target.new
end
def middle
  build()
end
