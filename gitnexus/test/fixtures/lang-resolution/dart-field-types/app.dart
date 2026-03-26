import 'models.dart';

void processUser(User user) {
  user.address.save();
}
