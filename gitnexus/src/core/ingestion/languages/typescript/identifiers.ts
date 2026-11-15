/** Decode ECMAScript identifier escapes without changing written graph identities. */
export const canonicalTypeScriptName = (name: string): string =>
  name.replace(
    /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
    (escape, braced: string | undefined, fixed: string | undefined) => {
      const value = Number.parseInt(braced ?? fixed!, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : escape;
    },
  );
