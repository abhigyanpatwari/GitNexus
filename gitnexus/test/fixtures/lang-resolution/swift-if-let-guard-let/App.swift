func processIfLet() {
    if let user = findUser() {
        user.save()
    }
}

func processGuardLet() {
    guard let repo = findRepo() else { return }
    repo.save()
}
