import type { User, Repo } from './models';

function main(): void {
  const user = new User();
  user.save();

  const repo = new Repo();
  repo.persist();
}

function typed(user: User, repo: Repo): void {
  user.save();
  repo.persist();
}
