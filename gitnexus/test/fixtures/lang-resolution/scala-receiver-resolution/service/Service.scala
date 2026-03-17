package service

import models.User
import models.Repo

class AppService {
  def processEntities(): Unit = {
    val user: User = new User()
    val repo: Repo = new Repo()
    user.save()
    repo.save()
  }
}
