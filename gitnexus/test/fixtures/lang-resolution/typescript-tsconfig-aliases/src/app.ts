import { UserService } from '@/services/user';

export function main(): void {
  const svc = new UserService();
  svc.save();
}
