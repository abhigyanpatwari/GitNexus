package models

trait Greeter {
  def greet(name: String): String
}

class User(val name: String, val email: String) extends Greeter {
  def greet(name: String): String = s"Hello, $name"

  def getEmail: String = email
}

object User {
  def create(name: String, email: String): User = new User(name, email)
}
