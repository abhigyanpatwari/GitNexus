package services

import models.getUser
import models.getRepo

fun processUser() {
    val user = getUser("alice")
    user.save()
}

fun processRepo() {
    val repo = getRepo("main")
    repo.save()
}
