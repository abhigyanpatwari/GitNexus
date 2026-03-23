fun processValues(data: HashMap<String, User>) {
    for (user in data.values) {
        user.save()
    }
}

fun processKeys(data: HashMap<User, Repo>) {
    for (user in data.keys) {
        user.save()
    }
}

fun processMutableMapValues(data: MutableMap<String, Repo>) {
    for (repo in data.values) {
        repo.save()
    }
}

fun processList(users: List<User>) {
    for (user in users) {
        user.save()
    }
}

fun processSet(repos: Set<Repo>) {
    for (repo in repos) {
        repo.save()
    }
}
