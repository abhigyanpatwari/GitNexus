// shadcn/Radix UI canonical pattern: every primitive component is wrapped
// in `React.forwardRef` so callers can attach a ref. The arrow inside is
// where the actual rendering logic lives — every call inside its body
// (cn(), helper(), JSX renders) should attribute to `Button`, not File.
//
// Pre-fix: `Button` was a Variable; calls inside attributed to File.
// Post-fix: `Button` is a Function; calls attribute to `Button`.

import { helper, cn } from './helpers';

// Stand-in for React.forwardRef — defined locally so the outer call_expression
// is in-fixture and we don't need to mock the React types. Same shape as
// the real React.forwardRef<T, P>.
const React = {
  forwardRef: <T, P>(render: (props: P, ref: T | null) => unknown) => render,
};

interface ButtonProps {
  className?: string;
  variant?: 'default' | 'ghost';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant }, _ref) => {
    const cls = cn('btn', variant ?? 'default', className ?? '');
    helper(cls);
    return null;
  },
);
