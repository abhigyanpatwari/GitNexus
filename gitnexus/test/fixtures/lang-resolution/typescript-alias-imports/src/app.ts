import { User as U, Repo as R } from './models';

export function main() {
  const u = new U('alice');
  const r = new R('https://example.com');
  u.save();
  r.persist();
}
