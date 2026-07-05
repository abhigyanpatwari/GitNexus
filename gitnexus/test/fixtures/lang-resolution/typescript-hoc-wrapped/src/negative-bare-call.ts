// Negative-control: bare statement-level HOC calls (NOT bound to a
// `const`/`let`/`var`) must NOT produce phantom Function nodes.
//
// This exercises the `parent.type === 'arguments'` branch in
// `tsExtractFunctionName`: the walk-up `arguments → call_expression →
// (program | expression_statement)` short-circuits because the parent
// of `call_expression` is NOT `variable_declarator`. The arrow stays
// anonymous and calls inside fall back to the enclosing module scope.

import { doStuff } from './helpers';

const useCallback = <F extends (...args: unknown[]) => unknown>(fn: F, _deps: unknown[]): F => fn;
const memo = <P,>(render: (props: P) => unknown) => render;

// Statement-level: result is discarded.
useCallback(() => {
  doStuff(1);
}, []);

memo<{ x: number }>(({ x }) => {
  doStuff(x);
});

// Function-arg position (passed to another call): also unbound.
const wrap = <T>(value: T): T => value;
wrap(
  memo<{ y: number }>(({ y }) => {
    doStuff(y);
  }),
);
