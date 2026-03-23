import { User } from './user';

function processEntries(entries: Map<string, User>) {
  for (const [key, user] of entries) {
    user.save();
  }
}
