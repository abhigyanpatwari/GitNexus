#include "user.h"

void processUser() {
    auto user = getUser("alice");
    user.save();
}
