#include "models/User.h"
#include "models/Repo.h"

void processEntities() {
    auto user = User("alice");
    auto repo = Repo("maindb");
    user.save();
    repo.save();
}
