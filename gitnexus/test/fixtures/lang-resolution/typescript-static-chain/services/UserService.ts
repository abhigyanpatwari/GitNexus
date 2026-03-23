import { User } from '../models/User';

export class UserService {
  static findUser(): User {
    return new User();
  }
}
