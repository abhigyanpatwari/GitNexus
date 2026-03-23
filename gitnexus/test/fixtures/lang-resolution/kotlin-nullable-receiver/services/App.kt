package services

import models.User
import models.Repo

fun processEntities() {
    val user: User? = User("alice")
    val repo: Repo? = Repo("maindb")

    // Safe calls on nullable receivers — should disambiguate via unwrapped type
    user?.save()
    repo?.save()
}
