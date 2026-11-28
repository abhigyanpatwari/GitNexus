import type * as models from './models.js';
import type * as other from './other.js';

interface User { local: boolean }

export function inspect<T = models.User>(
  rows: models.User[],
  choice: models.User | other.User,
  tuple: [other.User, User],
  pair: models.User & other.User,
  box: models.Box<other.User>,
  nested: models.Box<models.Box<other.User>>[] | models.Box<User>,
) {
  return choice satisfies (models.User | other.User);
}
