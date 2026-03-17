package service

import models.User
import models.Repo

class Service {
  def getUser(): User = new User()
  def getRepo(): Repo = new Repo()

  def processUser(): Unit = {
    val u = getUser()
    u.save()
  }

  def processRepo(): Unit = {
    val r = getRepo()
    r.save()
  }
}
