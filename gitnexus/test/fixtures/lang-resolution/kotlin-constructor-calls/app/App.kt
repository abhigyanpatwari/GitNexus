package app

import models.User

fun main() {
    val user = User("alice")
    user.save()
}
