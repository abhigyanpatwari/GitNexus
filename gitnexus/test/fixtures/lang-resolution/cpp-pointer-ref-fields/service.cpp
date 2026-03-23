#include "models.h"

void processUser(User user) {
    // Pointer member field access: user.address->save()
    user.address->save();
}
