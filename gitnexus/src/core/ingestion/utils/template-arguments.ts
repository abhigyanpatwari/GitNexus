import type { TypeRef } from 'gitnexus-shared';

/**
 * Parse top-level generic/template arguments from a type-like string.
 *
 * Examples:
 * - `List<int>` -> ['int']
 * - `Map<string, vector<int>>` -> ['string', 'vector<int>']
 * - `List<T*>` -> ['T*']
 */
export function extractTemplateArguments(text: string): string[] | undefined {
  const start = text.indexOf('<');
  if (start === -1) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return undefined;
    }
  }
  if (end === -1) return undefined;
  const inner = text.slice(start + 1, end);
  if (inner.trim().length === 0) return undefined;

  const args: string[] = [];
  let tokenStart = 0;
  let nested = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '<') nested += 1;
    else if (ch === '>') nested -= 1;
    else if (ch === ',' && nested === 0) {
      const token = inner.slice(tokenStart, i).replace(/\s+/g, '');
      if (token.length > 0) args.push(token);
      tokenStart = i + 1;
    }
  }
  const last = inner.slice(tokenStart).replace(/\s+/g, '');
  if (last.length > 0) args.push(last);
  return args.length > 0 ? args : undefined;
}

export function stripTemplateArguments(text: string): string {
  const start = text.indexOf('<');
  if (start === -1) return text;
  return text.slice(0, start);
}

export function templateArgumentsIdTag(templateArguments?: readonly string[]): string {
  if (templateArguments === undefined || templateArguments.length === 0) return '';
  return `~${templateArguments.join(',')}`;
}

/**
 * Stable short hash for the opaque `SymbolDefinition.templateConstraints`
 * payload (issue #1579). Two function-template overloads with identical
 * `parameterTypes` but mutually-exclusive SFINAE constraints
 * (`enable_if_t<is_integral_v<T>>` vs `enable_if_t<is_floating_point_v<T>>`)
 * must produce distinct graph node IDs so the constraint-filter step
 * has two candidates to narrow between. Without this they collapse to
 * a single Function node and the SFINAE golden case can only emit one
 * edge regardless of resolver fixes.
 *
 * FNV-1a 32-bit, base36 encoded. Deterministic; non-cryptographic — the
 * tag's job is collision-avoidance among same-name overloads in one
 * file, not security.
 */
export function constraintsHash(jsonText: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < jsonText.length; i++) {
    h ^= jsonText.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Build the `~c:<hash>` ID suffix from an opaque constraint payload.
 *  Returns empty string when the payload is absent so callers can
 *  string-concatenate unconditionally. */
export function templateConstraintsIdTag(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  return `~c:${constraintsHash(JSON.stringify(payload))}`;
}

/**
 * The type APPLICATION a type reference was reduced from — `Mapped[User]`,
 * `Repo<User>` — restored to the `Base<Args>` spelling, or `undefined` when
 * this reference is not that shape.
 *
 * ── WHY A LOOKUP MUST NOT BE HANDED THE REDUCED NAME ─────────────────────────
 *
 * `rawName` is post-normalization (see its docstring on `TypeRef`), and several
 * providers reduce a type application to its BASE NAME at capture time —
 * `Mapped[User]` → `Mapped`, `Repo<User>` → `Repo`. That erasure is what lets
 * one declaration answer for every instantiation of it, and it is also the
 * widest step any lookup in this pipeline takes: reaching a declaration by NAME
 * ALONE binds whatever the workspace happens to declare under that name. A
 * third-party `Mapped[User]` beside an unrelated workspace `class Mapped` is
 * then a confident WRONG edge, which is strictly worse than the missing one it
 * replaced.
 *
 * `resolveClassBindingForName` already owns the rule for this — it admits an
 * erased base name only on grounds that connect the site to the declaration
 * (the scope chain binds the name; the declaration is in the same file; the
 * index proves the name is a template family; the file has no cross-file class
 * channel to be absent from). But that route is entered on the SPELLING: a name
 * carrying its arguments takes it, a name already reduced to its base cannot,
 * because nothing distinguishes it from an ordinary class name. So a provider
 * that reduces at capture time sends its receivers down the ungrounded route by
 * construction, whatever the shared lookup does.
 *
 * Restoring the application from `declaredSpelling` — which keeps the
 * annotation exactly as written whenever normalization changed it — puts those
 * receivers back on the grounded route. Restoring rather than reimplementing
 * the grounding here is deliberate: the rule is one rule, and a second copy of
 * it in this file would be free to drift from the one in `scope/walkers.ts`
 * that every other caller uses. (Its predicate is not exported; the exported
 * entry point is the spelling.)
 *
 * ── WHAT COUNTS AS AN APPLICATION ────────────────────────────────────────────
 *
 * `rawName` must be the base the spelling APPLIES arguments to, and the
 * argument list must be the whole of the rest of the spelling — one list,
 * balanced, non-empty. Everything else is left exactly as it resolves today,
 * because a transform that is not certain is a worse failure than no transform:
 *
 *   - `User[]` — an array whose ELEMENT the capture layer already reduced to
 *     `User`. The position is the element, not an application of `User`, and
 *     the empty list is what says so.
 *   - `User[][]` — likewise, and it closes its first list before the end.
 *   - `std::vector<Item>` reduced to `vector<Item>` — the spelling does not
 *     start with the reduced name, so nothing was erased that this can restore.
 *   - `Repo<User>?`, `Map<String, (Int) -> Unit>` — trailing decoration and an
 *     argument list that does not close where it must. Declining leaves the
 *     pre-existing behaviour, which is what "no transform" has to mean.
 *
 * The rebuilt spelling uses ANGLE brackets because that is the spelling
 * `resolveClassBindingForName`'s contract is written against; the punctuation a
 * language spells type application with is not otherwise meaningful here, and
 * nothing downstream reads this string except that lookup.
 */
export function erasedTypeApplication(typeRef: TypeRef): string | undefined {
  const spelling = typeRef.declaredSpelling?.trim();
  if (spelling === undefined) return undefined;
  const base = typeRef.rawName.trim();
  if (base.length === 0 || !spelling.startsWith(base)) return undefined;
  const rest = spelling.slice(base.length).trimStart();
  const opener = rest[0];
  if (opener !== '<' && opener !== '[') return undefined;
  const closer = opener === '<' ? '>' : ']';
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === opener) depth++;
    else if (rest[i] === closer) {
      depth--;
      // The list the spelling opened must close on the LAST character, and must
      // have held something: `Repo[User]` yes, `User[]` no, `User[][]` no.
      if (depth === 0) {
        return i === rest.length - 1 && i > 1 ? `${base}<${rest.slice(1, i)}>` : undefined;
      }
    }
  }
  return undefined;
}
