import { User } from './user';
import { Repo } from './repo';

function findUser(): User | null { return new User(); }
function findRepo(): Repo | undefined { return new Repo(); }

// Nullable type + assignment chain: the nullable union must be stripped
// before the alias can resolve to User.
export function nullableChainUser(): void {
  const u: User | null = findUser();
  const alias = u;
  alias.save();
}

// Same pattern with Repo | undefined
export function nullableChainRepo(): void {
  const r: Repo | undefined = findRepo();
  const alias = r;
  alias.save();
}

// Triple nullable: User | null | undefined → still User
export function tripleNullable(): void {
  const u: User | null | undefined = findUser();
  const alias = u;
  alias.save();
}
