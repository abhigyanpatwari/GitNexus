require_relative "middle"
def entry
  middle()
end
first = Source::Target.new
second = Other::Target.new
label = "Target"
# Target stays here.
