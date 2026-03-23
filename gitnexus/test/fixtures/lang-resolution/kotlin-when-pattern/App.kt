import models.User
import models.Repo

fun processAny(obj: Any) {
    when (obj) {
        is User -> obj.save()
        is Repo -> obj.save()
    }
}

fun handleUser(obj: Any) {
    when (obj) {
        is User -> obj.save()
    }
}
