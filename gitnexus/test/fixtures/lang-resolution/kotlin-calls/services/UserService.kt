package services

import util.OneArg.writeAudit
import util.ZeroArg.writeAudit

class UserService {
    fun processUser() {
        writeAudit("hello")
    }
}
