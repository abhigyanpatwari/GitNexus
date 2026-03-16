#include "../models/User.h"
#include "../models/Repo.h"

void process() {
  auto user = User{};
  user.save();

  auto repo = Repo{};
  repo.save();
}
