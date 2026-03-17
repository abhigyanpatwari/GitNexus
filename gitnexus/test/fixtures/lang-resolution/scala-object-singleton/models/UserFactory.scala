package models

object UserFactory {
  def create(name: String): User = new User(name)
}
