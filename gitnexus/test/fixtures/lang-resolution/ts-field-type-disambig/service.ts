import { User } from './user';

function processUser(user: User) {
  // Field-access chain: user.address resolves to Address, then .save() must resolve
  // to Address#save (NOT User#save) — only lookupFieldByOwner can disambiguate.
  user.address.save();
}
