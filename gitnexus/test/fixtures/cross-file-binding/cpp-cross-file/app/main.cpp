#include "../models/user_factory.h"

void process() {
    User user = get_user();
    user.save();
    user.get_name();
}
