import { User } from '../models/User';

export class UserService {
  getUser(): User {
    return new User();
  }
}
