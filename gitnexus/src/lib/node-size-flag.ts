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

/** Last value of the named V8 size flag, including zero. execArgv already
 * has argument boundaries, while NODE_OPTIONS needs Node's quote handling. */
export function readNodeSizeFlag(
  flags: string | readonly string[],
  name: string,
): number | undefined {
  const args = typeof flags === 'string' ? nodeOptionsArgs(flags) : flags;
  const option = '--' + name;
  let result: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (takesArgument.has(arg)) {
      i++;
      continue;
    }
    const equals = arg.indexOf('=');
    const key = equals < 0 ? arg : arg.slice(0, equals);
    if (key.replaceAll('_', '-') !== option) continue;
    const value = equals < 0 ? args[i + 1] : arg.slice(equals + 1);
    if (value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      result = Number(value);
      if (equals < 0) i++;
    }
  }
  return result;
}
