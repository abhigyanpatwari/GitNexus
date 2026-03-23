import { getUsers } from './models';

function process() {
  const users = getUsers();
  for (const u of users) {
    u.save();
  }
}
