class SqlRepository : Repository {
    override fun find(id: Int): String = "found-by-id"
    override fun find(name: String, exact: Boolean): String = "found-by-name"
    override fun save(data: String) { println(data) }
}
