#include "user.h"
#include "repo.h"

User getUser(const char* name) {
    return User(name);
}

Repo getRepo(const char* name) {
    return Repo(name);
}

void processUser() {
    auto user = getUser("alice");
    user.save();
}

void processRepo() {
    auto repo = getRepo("main");
    repo.save();
}
