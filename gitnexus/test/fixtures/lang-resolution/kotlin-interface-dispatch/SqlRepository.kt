class SqlRepository : Repository {
    override fun find(id: Int): String {
        return "found"
    }

    override fun save(entity: String): Boolean {
        return true
    }
}
