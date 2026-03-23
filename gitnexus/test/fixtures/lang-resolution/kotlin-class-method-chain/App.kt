// Assignment chain with typed parameter propagation.
// Tests that extractKotlinPendingAssignment handles val alias = u
// where u comes from an explicit typed declaration.
fun processUser() {
    val u: User = User()
    val alias = u
    alias.save()
}

fun processRepo() {
    val r: Repo = Repo()
    val alias = r
    alias.save()
}
