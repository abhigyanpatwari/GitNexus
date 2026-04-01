class Animal
  def speak
    raise NotImplementedError
  end

  def self.classify(name)
    "mammal"
  end

  private

  def internal_state
    @state
  end
end

class Dog < Animal
  def speak
    "woof"
  end

  protected

  def energy_level
    100
  end
end
