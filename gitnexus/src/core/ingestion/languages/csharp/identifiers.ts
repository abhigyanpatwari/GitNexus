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
