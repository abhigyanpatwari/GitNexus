import Child from './c/Child';
import { Named } from './c/Named';
import plainFn from './c/plain';
export default function Parent() {
  const v = plainFn(1);
  return <div><Child a={v} /><Named /></div>;
}
