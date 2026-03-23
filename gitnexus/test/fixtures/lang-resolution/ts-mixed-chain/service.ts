import { User, UserService } from './models';

function processWithService(svc: UserService) {
  // call → field → call: svc.getUser().address.save()
  svc.getUser().address.save();
}

function processWithUser(user: User) {
  // field → call → call: user.getAddress().city.getName()
  user.getAddress().city.getName();
}
