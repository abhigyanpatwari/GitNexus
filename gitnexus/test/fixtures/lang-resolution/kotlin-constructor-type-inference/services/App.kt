package services

import models.User
import models.Repo

fun processEntities() {
    val user = User("alice")
    val repo = Repo("maindb")
    user.save()
    repo.save()
}
