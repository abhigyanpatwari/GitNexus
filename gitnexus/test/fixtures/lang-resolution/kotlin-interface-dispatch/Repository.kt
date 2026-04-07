interface Repository {
    fun find(id: Int): String
    fun save(entity: String): Boolean
}
