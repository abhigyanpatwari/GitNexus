/**
 * One argument of a Spring annotation or of a messaging-template call, captured
 * exactly as it is written in source.
 *
 * Capture-time facts are deliberately UNRESOLVED. When these facts are produced
 * the file's imports are not finalized, constants declared in sibling files do
 * not exist yet, and no configuration source has been read — so a captured
 * `text` may be a string literal, a constant reference (`Destinations.ORDERS`),
 * a property placeholder (`"${app.orders.topic}"`), or an arbitrary expression.
 * Turning any of those into an address is a separate, later phase; nothing here
 * may call a resolver.
 *
 * NOT the same thing as `SpringAnnotationArgument` in `annotation-arguments.ts`,
 * and the two are deliberately not merged:
 *
 *  - Source. This fact is built from AST nodes while the tree is in hand;
 *    `parseSpringAnnotationArguments` re-parses an annotation's `text` much
 *    later, from a string, with a hand-written delimiter scanner.
 *  - Failure. The text parser returns `null` when its scanner cannot balance
 *    the input, and a caller must decide what that means. There is no such
 *    state here: the grammar has already decided where each argument begins
 *    and ends.
 *  - Absence. The text parser answers `[]` both for `@Scheduled` and for
 *    `@Scheduled()`, because a string cannot tell "no list" from "empty list"
 *    without re-deriving it. Capture keeps the two apart — absent versus `[]` —
 *    and downstream code is expected to rely on that distinction.
 *  - Scope. This fact also describes CALL arguments (`template.send(topic, p)`),
 *    which the annotation parser has no notion of.
 *
 * Collapsing them would mean giving the text parser a failure mode it cannot
 * produce, or taking the three-state distinction away from capture.
 */
export interface SpringArgumentFact {
  /**
   * Argument name for a named argument, absent for a positional one.
   *
   * The two forms carry the same information in different places: an annotation
   * names its destination (`@KafkaListener(topics = ...)` versus
   * `@RabbitListener(queues = ...)`), while a template call gives it by
   * position (`kafkaTemplate.send(topic, payload)`).
   */
  readonly name?: string;
  /** Argument value exactly as written, with quotes, braces, and casts intact. */
  readonly text: string;
}

/**
 * Join an expression that the source wrapped across lines, so that one
 * expression has one spelling no matter where it was written.
 *
 * A receiver chain written as `outer\n    .inner\n    .kafkaTemplate`, and an
 * argument written as `Destinations\n    .ORDERS`, are the same expressions as
 * their single-line spellings. Raw node text would carry the newline and the
 * ENCLOSING BLOCK's indentation across the worker boundary, so the same
 * expression at two nesting depths — or in a CRLF checkout — would not compare
 * equal downstream. Receivers and arguments get the identical treatment on
 * purpose: an inconsistent rule inside one fact is a trap for the phase that
 * has to match a publish against a subscription.
 *
 * Only a run of whitespace that CONTAINS A NEWLINE and sits next to a dot is
 * removed, and only OUTSIDE a string literal. Single-line spacing is left
 * alone, so `registry.get("a . b").template` keeps its argument exactly as
 * written; literal-awareness extends that to Java text blocks and Kotlin raw
 * strings, whose embedded newlines are part of the value and must survive
 * (`"""line-a\n.line-b"""` is not the same string as `"""line-a.line-b"""`).
 *
 * Wraps that are not adjacent to a dot (`"a" +\n  "b"`) are left as written:
 * normalizing them would have to reason about operators, and the same
 * conservatism already applies to receivers.
 */
export function normalizeSpringFactText(text: string): string {
  const trimmed = text.trim();
  // Fast path: the overwhelming majority of captured text is single-line.
  if (!trimmed.includes('\n') && !trimmed.includes('\r')) return trimmed;

  let out = '';
  let index = 0;
  let quote: '"""' | '"' | "'" | null = null;
  while (index < trimmed.length) {
    const char = trimmed[index] as string;
    if (quote === '"""') {
      if (trimmed.startsWith('"""', index)) {
        out += '"""';
        index += 3;
        quote = null;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (quote !== null) {
      // A backslash escape is copied whole so that `"\\"` ends the literal and
      // `"\""` does not.
      if (char === '\\' && index + 1 < trimmed.length) {
        out += trimmed.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }
    if (trimmed.startsWith('"""', index)) {
      quote = '"""';
      out += '"""';
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '.' || /\s/.test(char)) {
      const separator = /^\s*\.\s*/.exec(trimmed.slice(index));
      if (separator !== null) {
        const matched = separator[0];
        out += matched.includes('\n') ? '.' : matched;
        index += matched.length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}
