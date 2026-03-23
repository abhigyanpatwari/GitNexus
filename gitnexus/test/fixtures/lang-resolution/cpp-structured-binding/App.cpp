#include "User.h"
#include "Repo.h"
#include <map>
#include <string>
#include <vector>

void processUserMap(std::map<std::string, User> userMap) {
    for (auto& [key, user] : userMap) {
        user.save();
    }
}

void processRepoMap(std::map<std::string, Repo> repoMap) {
    for (const auto& [key, repo] : repoMap) {
        repo.save();
    }
}
