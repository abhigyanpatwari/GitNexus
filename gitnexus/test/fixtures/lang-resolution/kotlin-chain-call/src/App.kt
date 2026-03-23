import models.User
import services.UserService

fun processUser() {
    val svc = UserService()
    svc.getUser().save()
}
