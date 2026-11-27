/** Node splits NODE_OPTIONS on spaces. Double quotes group an argument, and
 * backslashes escape the following character inside a quoted string. */
function nodeOptionsArgs(options: string): string[] {
  const args: string[] = [];
  let word = '';
  let quoted = false;
  for (let i = 0; i < options.length; i++) {
    const char = options[i];
    if (char === '"') quoted = !quoted;
    else if (char === '\\' && quoted) word += options[++i] ?? '';
    else if (char === ' ' && !quoted) {
      if (word) args.push(word);
      word = '';
    } else word += char;
  }
  if (word) args.push(word);
  return args;
}

const takesArgument = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '--import',
  '--loader',
]);

/** The argument list of execArgv (already split) or a NODE_OPTIONS string. */
function toArgs(flags: string | readonly string[]): readonly string[] {
  return typeof flags === 'string' ? nodeOptionsArgs(flags) : flags;
}

/** V8 accepts one or two leading dashes and treats `-` and `_` alike. */
function flagName(arg: string): string | undefined {
  return /^--?([^-=][^=]*)/.exec(arg)?.[1].replaceAll('_', '-');
}

/**
 * Visit each flag in `flags` with its name and inline (`=`) value, skipping the
 * values of options that take the next argument. `next()` consumes and returns
 * the following argument as a separate value, unless it is itself an option.
 */
function eachFlag(
  flags: string | readonly string[],
  visit: (name: string, value: string | undefined, next: () => string | undefined) => void,
): void {
  const args = toArgs(flags);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (takesArgument.has(arg)) {
      i++;
      continue;
    }
    const name = flagName(arg);
    if (name === undefined) continue;
    const equals = arg.indexOf('=');
    const next = (): string | undefined =>
      i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : undefined;
    visit(name, equals < 0 ? undefined : arg.slice(equals + 1), next);
  }
}

/** Last value of the named option, given as `--name=value` or `--name value`. */
export function readNodeFlagValue(
  flags: string | readonly string[],
  name: string,
): string | undefined {
  let result: string | undefined;
  eachFlag(flags, (flag, value, next) => {
    if (flag === name) result = value ?? next();
  });
  return result;
}

const MAX_SIZE_T = 2n ** 64n - 1n;

/** Last value of the named V8 size flag, including zero. execArgv already
 * has argument boundaries, while NODE_OPTIONS needs Node's quote handling.
 * V8 reads the value like `strtoull` (leading whitespace and a sign allowed)
 * and ignores one out of its bounds, keeping the earlier value. A value V8
 * accepts but JavaScript cannot hold exactly is NaN: its effect is unknown. */
export function readNodeSizeFlag(
  flags: string | readonly string[],
  name: string,
): number | undefined {
  let result: number | undefined;
  eachFlag(flags, (flag, inline, next) => {
    if (flag !== name) return;
    const value = inline ?? next();
    const match = value === undefined ? null : /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(value);
    if (!match) return;
    const digits = BigInt(match[2]);
    if (digits === 0n) result = 0;
    else if (match[1] === '-' || digits > MAX_SIZE_T) return;
    else result = digits <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(digits) : NaN;
  });
  return result;
}

/** Last setting of the named V8 boolean flag: true for `--name`, false for
 * `--no-name` or `--noname` (V8 accepts both), undefined when absent. */
export function readNodeBooleanFlag(
  flags: string | readonly string[],
  name: string,
): boolean | undefined {
  let result: boolean | undefined;
  eachFlag(flags, (flag) => {
    if (flag === name) result = true;
    else if (flag === `no-${name}` || flag === `no${name}`) result = false;
  });
  return result;
}

/** The size flag this process runs under. Node applies the command line after
 * NODE_OPTIONS, so a command-line value wins even when it is zero. */
export function processNodeSizeFlag(
  name: string,
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): number | undefined {
  return readNodeSizeFlag(execArgv, name) ?? readNodeSizeFlag(nodeOptions, name);
}

/** The boolean flag this process runs under, the command line winning. */
export function processNodeBooleanFlag(
  name: string,
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): boolean | undefined {
  return readNodeBooleanFlag(execArgv, name) ?? readNodeBooleanFlag(nodeOptions, name);
}
