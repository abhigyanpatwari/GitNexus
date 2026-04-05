class DbLookup : ILookup {
    override fun find(id: Int): String {
        return "by-id"
    }

    override fun find(name: String): String {
        return "by-name"
    }
}
