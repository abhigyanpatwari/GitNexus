require_relative "source"
def build
  Source::Renamed.new
end
def middle
  build()
end
