// MobX `observer` HOC: `const Card = observer((props) => { ... })`. Same
// shape as `memo` but the wrapper is named `observer`. Used heavily in
// MobX-based React codebases.

import { helper } from './helpers';

const observer = <P,>(render: (props: P) => unknown) => render;

interface ItemProps {
  label: string;
}

export const Item = observer<ItemProps>(({ label }) => {
  helper(label);
  return null;
});
