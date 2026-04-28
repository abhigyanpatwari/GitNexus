require_relative './animal'

def main
  dog = Dog.new
  sound = dog.speak
  category = Animal.classify("dog")
end
