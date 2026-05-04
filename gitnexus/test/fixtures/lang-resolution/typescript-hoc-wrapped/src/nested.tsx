// Nested HOCs: `const X = memo(forwardRef((p, r) => { ... }))`.
//
// Tree-sitter shape:
//   variable_declarator
//     value: call_expression  (memo(...))
//       arguments: arguments
//         call_expression  (forwardRef(arrow))    ← FIRST positional arg
//           arguments: arguments
//             arrow_function                       ← deepest behaviour-arrow
//
// Our outermost lexical_declaration → call_expression → arguments →
// arrow_function pattern requires the arrow to be a direct child of the
// outermost call's `arguments` — which it is NOT here (it's two levels
// deeper). So the OUTER pattern misses. But the same pattern, anchored
// on the INNER call (`forwardRef(arrow)`), wouldn't match either: the
// inner call_expression is a child of `arguments`, not of a
// `variable_declarator`.
//
// So the question is: which Function name does `arrow_function`'s
// `tsExtractFunctionName` resolve to in the legacy DAG?
//
//   arrow.parent      = arguments       (forwardRef's args)
//   arguments.parent  = call_expression (forwardRef(...))
//   call_expr.parent  = arguments       (memo's args) ← NOT variable_declarator!
//
// The legacy walker requires `call_expression.parent === variable_declarator`,
// so it returns null → arrow stays anonymous. Same for the registry-primary
// query (the lexical_declaration shape doesn't match because the arrow
// isn't a direct grandchild of the outer call).
//
// CURRENT STATE (post-fix): the deepest arrow is anonymous, calls inside
// fall back to the next named ancestor. There IS no named ancestor here
// (the outer `forwardRef` and `memo` calls don't have variable_declarator
// `value:` containing them — they ARE that value). So calls walk up to
// File. The OUTER `Wrapped` const is named `Variable:Wrapped`, not a
// Function — because no Function pattern matches the OUTER shape either
// (the immediate arg of `memo(...)` is a `call_expression`, not an arrow).
//
// This file documents a known limitation: deep-nested HOCs (memo of
// forwardRef of arrow) lose attribution at depth ≥ 2. The test below
// asserts the ABSENCE of phantom edges (we don't make this worse) rather
// than positive resolution. A future fix would require recursing into
// arguments-containing-call_expression on the value side, which has its
// own trade-offs (which level wins the name?).

import { helper } from './helpers';

const memo = <P,>(render: (props: P) => unknown) => render;
const forwardRef = <T, P>(render: (props: P, ref: T | null) => unknown) => render;

interface DeepProps {
  label: string;
}

export const Wrapped = memo(
  forwardRef<HTMLDivElement, DeepProps>(({ label }, _ref) => {
    helper(label);
    return null;
  }),
);
