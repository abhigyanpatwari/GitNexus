#include "service.h"
#include "user.h"
#include "repo.h"

void processUser() {
    UserService svc;
    svc.getUser().save();
}
