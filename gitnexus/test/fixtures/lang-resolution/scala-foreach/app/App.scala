package app

import models.User
import models.Repo

object App {
  def processUsers(users: List[User]): Unit = {
    for (user <- users) {
      user.save()
    }
  }

  def processRepos(repos: List[Repo]): Unit = {
    for (repo <- repos) {
      repo.save()
    }
  }
}
