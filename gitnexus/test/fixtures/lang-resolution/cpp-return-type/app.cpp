#include "user.h"

User getUser(const char* name) {
    return User(name);
}

void processUser() {
    auto user = getUser("alice");
    user.save();
}
