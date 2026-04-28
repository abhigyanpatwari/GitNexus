fun main() {
    val repo = SqlRepository()
    repo.find(42)
    repo.find("alice", true)
    repo.save("test")
}
