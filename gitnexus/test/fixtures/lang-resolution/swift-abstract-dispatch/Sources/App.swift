func process() {
    let repo = SqlRepository()
    let user = repo.find(id: 42)
    let _ = repo.save(entity: user)
}
