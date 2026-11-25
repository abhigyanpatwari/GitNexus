/** Restore only the process variables changed by this fixture. */
export function createTestEnvironment() {
  const original = new Map<string, string | undefined>();
  function assign(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return {
    set(name: string, value: string | undefined) {
      if (!original.has(name)) original.set(name, process.env[name]);
      assign(name, value);
    },
    restore() {
      for (const [name, value] of original) assign(name, value);
      original.clear();
    },
  };
}
