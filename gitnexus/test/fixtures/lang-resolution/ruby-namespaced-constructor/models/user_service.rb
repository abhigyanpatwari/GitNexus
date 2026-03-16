module Models
  class UserService
    def process(name)
      name.upcase
    end

    def validate
      true
    end
  end
end
