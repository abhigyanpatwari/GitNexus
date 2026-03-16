package services

import models.User
import models.Repo

class AppService {
    fun processEntities() {
        val user: User = User()
        val repo: Repo = Repo()
        user.save()
        repo.save()
    }
}
