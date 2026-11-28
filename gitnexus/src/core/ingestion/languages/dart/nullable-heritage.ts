import { withoutTypeComments } from '../../utils/type-parameters.js';

// A Dart nominal type is a (possibly library-prefixed) name, an optional
// type argument list, and an optional nullable suffix, in that order.
const tokens =
  /[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)?|[^\s]/gu;
const startsName = /^[$_\p{ID_Start}]/u;

export function dartNominalType(spelling: string): string | null {
  let depth = 0;
  let previous = '';
  const result: string[] = [];
  for (const [token] of withoutTypeComments(spelling).matchAll(tokens)) {
    if (previous === '' || previous === '<' || previous === ',') {
      if (!startsName.test(token)) return null;
    } else if (token === '<' && startsName.test(previous)) {
      depth++;
    } else if (token === '>' && depth > 0) {
      depth--;
    } else if (!(token === ',' && depth > 0) && !(token === '?' && previous !== '?')) {
      return null;
    }
    result.push(token.replace(/\s+/gu, ''));
    previous = token;
  }
  return !previous || previous === ',' || depth ? null : result.join('');
}
