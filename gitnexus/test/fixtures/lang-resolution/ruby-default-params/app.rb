def greet(name, greeting = "Hello")
  "#{greeting}, #{name}"
end

def process
  greet("Alice")
  greet("Bob", "Hi")
end
