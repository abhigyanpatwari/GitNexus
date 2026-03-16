package services

import models.Handler
import models.Runnable

class UserHandler : Handler(), Runnable {
    override fun run() {}
}
