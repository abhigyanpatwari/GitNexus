import { getUser, fetchUserAsync } from './service';

function processUser() {
  const user = getUser('alice');
  user.save();
}

async function processUserAsync() {
  const user = await fetchUserAsync('bob');
  user.save();
}
