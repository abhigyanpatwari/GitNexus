import { UserService } from './services/UserService';

// Chain base is a class name, not a variable.
// Requires class-as-receiver fallback on the chain base resolution.
export function processUser(): void {
  UserService.findUser().save();
}
