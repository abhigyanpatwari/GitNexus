import { getUser } from './service';

function processChain() {
  const user = getUser();
  const addr = user.address;
  const city = addr.getCity();
  city.save();
}
