package app

import models.User
import service.Service

object App {
  def processUser(): Unit = {
    val svc = new Service()
    svc.getUser().save()
  }
}
