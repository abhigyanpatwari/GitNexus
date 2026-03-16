package services

import models.User

class UserService {
    fun processUser(): Boolean {
        val user = User()
        return user.save()
    }
}
