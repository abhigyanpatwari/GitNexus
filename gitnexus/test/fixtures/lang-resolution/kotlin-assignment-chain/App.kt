fun getUser(): User = User()
fun getRepo(): Repo = Repo()

fun processEntities() {
    val u: User = getUser()
    val alias = u
    alias.save()

    val r: Repo = getRepo()
    val rAlias = r
    rAlias.save()
}
