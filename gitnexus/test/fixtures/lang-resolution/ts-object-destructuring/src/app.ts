import { getUser } from './service';

function processDestructured() {
  const user = getUser();
  const { address } = user;
  address.save();
}

function processMultiField() {
  const user = getUser();
  const { name, address } = user;
  address.save();
}
