interface Repository {
    fun find(id: Int): String
    fun find(name: String, exact: Boolean): String
    fun save(data: String)
}
