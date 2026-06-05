import React, { Component, forwardRef, memo, useRef } from 'react';

interface BaseInputProps {
  name: string;
}

/**
 * Top-level React hook binding (not inside a class) — exercises the same
 * `lexical_declaration` + `use[A-Z]` predicate path as `handleClick` /
 * `value` in MyComponent.tsx. Asserts the binding is captured as a
 * Function node in the graph.
 */
const ref = useRef<HTMLInputElement>(null);

/**
 * Class component — must register as a Class node, not just a Function.
 * The `extends Component<BaseInputProps>` heritage gives it the
 * `React.Component` ancestor edge.
 */
export class ClassInput extends Component<BaseInputProps> {
  render() {
    return <input ref={ref} name={this.props.name} />;
  }
}

/**
 * `forwardRef` returns a ForwardRefExoticComponent — not a hook. With the
 * `use[A-Z]` predicate the binding must NOT be captured as a function, so
 * `WrappedInput` should not appear as a Function node. It should still
 * appear in the call graph as the call target of `forwardRef`.
 */
export const WrappedInput = forwardRef<HTMLInputElement, BaseInputProps>(
  (props, ref) => <ClassInput ref={ref} name={props.name} />,
);

/**
 * `memo` likewise is a HOC, not a hook. `MemoizedInput` should not be
 * captured as a Function node.
 */
export const MemoizedInput = memo((props: BaseInputProps) => {
  return <WrappedInput ref={null} name={props.name} />;
});

