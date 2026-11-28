/** Semantic identifier spelling; source graph names and ranges remain unchanged. */
export const canonicalName = (name: string): string =>
  name
    .replace(/^@/, '')
    .replace(
      /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g,
      (escape, short: string | undefined, long: string | undefined) => {
        const value = Number.parseInt(short ?? long!, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
      },
    );

/** C# aliases used in generic type argument comparison. */
export const CSHARP_PREDEFINED_TYPE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['bool', 'Boolean'],
  ['byte', 'Byte'],
  ['sbyte', 'SByte'],
  ['char', 'Char'],
  ['decimal', 'Decimal'],
  ['double', 'Double'],
  ['float', 'Single'],
  ['int', 'Int32'],
  ['uint', 'UInt32'],
  ['long', 'Int64'],
  ['ulong', 'UInt64'],
  ['short', 'Int16'],
  ['ushort', 'UInt16'],
  ['nint', 'IntPtr'],
  ['nuint', 'UIntPtr'],
  ['object', 'Object'],
  ['string', 'String'],
]);

const systemKeywords = new Map(
  Array.from(CSHARP_PREDEFINED_TYPE_ALIASES, ([keyword, name]) => ['System.' + name, keyword]),
);

/** Framework identity only after resolving any workspace declaration of this name. */
export function csharpSystemKeyword(qualifiedName: string): string | undefined {
  return systemKeywords.get(qualifiedName);
}

/** Native-sized integer aliases are contextual and can name workspace declarations. */
export function isCsharpReservedTypeKeyword(name: string): boolean {
  return (
    name === 'void' ||
    (name !== 'nint' && name !== 'nuint' && CSHARP_PREDEFINED_TYPE_ALIASES.has(name))
  );
}
