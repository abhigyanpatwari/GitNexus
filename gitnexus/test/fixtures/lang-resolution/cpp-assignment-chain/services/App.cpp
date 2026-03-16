#include "models/User.h"
#include "models/Repo.h"

// Tests C++ auto alias = u assignment chain propagation.
void processEntities() {
    User u("alice");
    auto alias = u;
    alias.save();

    Repo r("maindb");
    auto rAlias = r;
    rAlias.save();
}
