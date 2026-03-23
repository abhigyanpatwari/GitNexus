import { User } from './user';
import { Repo } from './repo';

function getUser(): User { return new User(); }
function getRepo(): Repo { return new Repo(); }

// Multi-hop forward-declared chain: a → b → c (source order)
// All three should resolve because the post-walk pass processes in order.
export function multiHopForward(): void {
  const a: User = getUser();
  const b = a;
  const c = b;
  c.save();
}

// Multi-hop with Repo to prove disambiguation
export function multiHopRepo(): void {
  const a: Repo = getRepo();
  const b = a;
  const c = b;
  c.save();
}
