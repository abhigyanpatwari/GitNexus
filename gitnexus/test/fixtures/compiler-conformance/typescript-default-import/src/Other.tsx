import Kid from './c/Widget';
import { default as P } from './c/plain';
import h from './c/helper';
import arrow from './c/arrow';
export function Other() {
  P(2);
  h();
  arrow();
  return <Kid />;
}
