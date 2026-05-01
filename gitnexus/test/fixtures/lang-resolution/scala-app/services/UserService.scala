package services

import models.User

object UserService {
  def createUser(name: String, email: String): User = {
    User.create(name, email)
  }

  def process(user: User): Unit = {
    val greeting = user.greet(user.name)
    println(greeting)
  }
}
