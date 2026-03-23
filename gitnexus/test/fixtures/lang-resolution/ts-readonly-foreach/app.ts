import { User } from './models/user';
import { Repo } from './models/repo';

function processUsers(users: readonly User[]) {
  for (const user of users) {
    user.save();
  }
}

function processRepos(repos: readonly Repo[]) {
  for (const repo of repos) {
    repo.save();
  }
}
