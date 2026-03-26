import 'models.dart';

void processUser() {
  var user = getUser('alice');
  user.save();
}
