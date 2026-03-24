import { getUser } from './models';

export function run() {
  const u = getUser();
  u.save();
  u.getName();
}
