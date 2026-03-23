import { User, Address } from './models';

function updateUser(user: User) {
  // Write access: user.name = "Alice"
  user.name = "Alice";

  // Write access: user.address = new Address()
  user.address = new Address();
}
