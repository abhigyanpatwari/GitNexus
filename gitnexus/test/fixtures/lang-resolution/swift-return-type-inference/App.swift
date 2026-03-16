func getUser() -> User {
    return User(name: "alice")
}

func getRepo() -> Repo {
    return Repo(name: "main")
}

func processUser() {
    let user = getUser()
    user.save()
}

func processRepo() {
    let repo = getRepo()
    repo.save()
}
