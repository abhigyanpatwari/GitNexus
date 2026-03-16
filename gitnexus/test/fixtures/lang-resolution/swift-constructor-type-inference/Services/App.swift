import Models

func processEntities() {
    let user = User(name: "alice")
    let repo = Repo(dbName: "maindb")
    user.save()
    repo.save()
}
