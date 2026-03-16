package services

import models.User
import interfaces.Serializable

class UserService {
    fun processUser(user: User) {
        user.validate()
        user.save()
    }
}
