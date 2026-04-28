package app

import models.getUser

class AConsumer {
    fun run() {
        val u = getUser()
        u.save()
    }
}
