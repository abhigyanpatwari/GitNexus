import { Models } from './barrel';

export function main(): void {
  const u = new Models.User();
  u.save();
}
