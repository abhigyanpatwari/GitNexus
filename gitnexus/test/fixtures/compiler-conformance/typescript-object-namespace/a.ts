import * as ns from './x';
import * as other from './y';

export const holder = {
  ns: 1,
  other: other,
  m() {
    ns.f();
  },
  arrow: () => {
    ns.f();
  },
};
