package services

import models.User
import models.findUser

fun processNullable(x: User?) {
    if (x != null) {
        x.save()
    }
}

fun processLocalNullable() {
    val x: User? = findUser()
    if (x != null) {
        x.save()
    }
}
