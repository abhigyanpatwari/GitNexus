#include "models.h"

void processUser(User user) {
    // Field-access chain: user.address → Address, then .save() → Address#save
    user.address.save();
}
