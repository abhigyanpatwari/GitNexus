#include "../b_provider/provider.h"

void process() {
    User user = get_user();
    user.save();
}
