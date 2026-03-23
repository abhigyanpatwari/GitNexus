import { UserService } from './services/UserService';

// svc is typed via parameter annotation, NOT constructor binding.
// The chain base type must come from typeEnv, not receiverMap.
export function processUser(svc: UserService): void {
  svc.getUser().save();
}
