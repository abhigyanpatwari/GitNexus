// Bare-identifier HOC form: `const Card = memo((props) => { ... })`.
// Common when the HOC is named-imported (`import { memo } from 'react'`)
// rather than accessed via a namespace (`React.memo`). Both should work.

import { helper, cn } from './helpers';

const memo = <P,>(render: (props: P) => unknown) => render;

interface CardProps {
  title: string;
  className?: string;
}

export const Card = memo<CardProps>(({ title, className }) => {
  const cls = cn('card', className ?? '');
  helper(title);
  helper(cls);
  return null;
});
