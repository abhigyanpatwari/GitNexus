package app

import models.User
import models.Repo

object App {
  def processEntities(): Unit = {
    val user: User = new User()
    val alias = user
    alias.save()

    val repo: Repo = new Repo()
    val rAlias = repo
    rAlias.save()
  }
}
