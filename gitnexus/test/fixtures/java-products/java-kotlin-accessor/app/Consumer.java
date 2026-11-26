package app;
import models.User;
class Consumer {
  String consume(User user) {
    return user.getName();
  }
}
