#include "models/User.h"
#include "models/Repo.h"

User* findUser() {
    return new User("alice");
}

Repo* findRepo() {
    return new Repo("maindb");
}

void processEntities() {
    User* user = findUser();
    Repo* repo = findRepo();

    // Pointer-based nullable receivers — should disambiguate via unwrapped type
    user->save();
    repo->save();
}
