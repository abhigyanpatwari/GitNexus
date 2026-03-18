import { getUsers } from './models/user';
import { getRepos } from './models/repo';

function processUsers(): void {
  for (const user of getUsers()) {
    user.save();
  }
}

function processRepos(): void {
  for (const repo of getRepos()) {
    repo.save();
  }
}
