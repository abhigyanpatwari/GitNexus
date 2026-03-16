import { User } from './models/User';
import { Repo } from './models/Repo';

// Both 'user' and 'repo' are created via constructor inference (no type annotation).
// The enclosing scope is 'run@0', with varNames 'user' and 'repo'.
// user.save() must resolve to User#save and repo.save() must resolve to Repo#save.
export function run(): void {
  const user = new User();
  const repo = new Repo();
  user.save();
  repo.save();
}
