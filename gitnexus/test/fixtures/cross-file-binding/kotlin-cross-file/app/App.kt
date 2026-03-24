package app

import models.getUser

class App {
    fun run() {
        val u = getUser()
        u.save()
        u.getName()
    }
}
