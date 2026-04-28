fun main() {
    val repo: Repository = SqlRepository()
    repo.find(1)
    repo.save("test")
}
