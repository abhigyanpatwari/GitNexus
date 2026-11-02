require_relative "middle"
def entry
  middle()
end
first = Source::Renamed.new
second = Other::Target.new
label = "Target"
# Target stays here.
