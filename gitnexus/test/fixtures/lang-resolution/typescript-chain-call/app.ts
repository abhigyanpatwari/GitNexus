import { UserService } from './services/UserService';

export function processUser(): void {
  const svc = new UserService();
  svc.getUser().save();
}
