class Animal
  def speak
    raise NotImplementedError
  end

  def self.classify(name)
    "mammal"
  end

  class << self
    def from_habitat(habitat)
      new
    end
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
