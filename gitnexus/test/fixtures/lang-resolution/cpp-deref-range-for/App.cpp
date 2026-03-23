#include "User.h"
#include "Repo.h"
#include <vector>

void processUsers(std::vector<User>* usersPtr) {
    for (auto& user : *usersPtr) {
        user.save();
    }
}

void processRepos(std::vector<Repo>* reposPtr) {
    for (const auto& repo : *reposPtr) {
        repo.save();
    }
}
