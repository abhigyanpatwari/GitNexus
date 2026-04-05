class App {
    fun crossFileById() {
        val db = DbLookup()
        db.find(42)
    }

    fun crossFileByName() {
        val db = DbLookup()
        db.find("alice")
    }

    fun chainIntToFormat() {
        val db = DbLookup()
        val fmt = Formatter()
        val result = db.find(42)
        fmt.format(result)
    }

    fun chainNameToFormat() {
        val db = DbLookup()
        val fmt = Formatter()
        val result = db.find("alice")
        fmt.format(result)
    }
}
