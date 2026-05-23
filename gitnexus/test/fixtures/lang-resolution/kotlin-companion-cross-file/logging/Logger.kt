package logging

class Logger(val name: String) {
    fun log(msg: String) {}
    companion object {
        fun create(name: String): Logger = Logger(name)
    }
}
