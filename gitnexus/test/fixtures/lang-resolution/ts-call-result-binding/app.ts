import { getUser } from './service';

function processUser() {
  const user = getUser('alice');
  user.save();
}

function processAlias() {
  const user = getUser('bob');
  const alias = user;
  alias.save();
}
