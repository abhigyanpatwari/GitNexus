import { User, Config } from './models';

function processUser(user: User) {
  // Field-access chain: user.address resolves to Address, then .save() resolves to Address#save
  user.address.save();
}

function validateConfig() {
  // Static field access: Config.DEFAULT resolves to Config, then .validate() resolves to Config#validate
  Config.DEFAULT.validate();
}
