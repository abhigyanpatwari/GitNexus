#include "user.h"

void processUser(const std::string& name) {
    auto user = new User(name);
    user->save();
}
