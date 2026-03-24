#include "models.h"

void processChain() {
    auto user = getUser();
    auto addr = user.address;
    auto city = addr.getCity();
    city.save();
}
