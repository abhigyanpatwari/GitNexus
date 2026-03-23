#include "User.h"
#include "Repo.h"
#include <vector>

void processUsers(const std::vector<User>& users) {
    for (auto& user : users) {
        user.save();
    }
}

void processRepos(const std::vector<Repo>& repos) {
    for (const auto& repo : repos) {
        repo.save();
    }
}
