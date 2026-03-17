package service

import models.User

class UserService {
  def processUser(): Unit = {
    val user: User = new User()
    user.save()
  }
}
