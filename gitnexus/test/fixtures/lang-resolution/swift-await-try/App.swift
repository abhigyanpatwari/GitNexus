func processAwait() async {
    let user = await fetchUser()
    user.save()
}

func processTry() throws {
    let repo = try parseRepo("main")
    repo.save()
}
