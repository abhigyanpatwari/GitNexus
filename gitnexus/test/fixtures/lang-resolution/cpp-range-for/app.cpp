#include "user.h"
#include <vector>

void processUsers(std::vector<User> users) {
    for (User& user : users) {
        user.save();
    }
}
