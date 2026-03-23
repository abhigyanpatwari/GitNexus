import { User } from './user';

function process(x) {
  if (x instanceof User) {
    x.save();
  }
}
