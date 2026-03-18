import { User } from './models';

function processUser(user: User) {
  user.address.save();
}
