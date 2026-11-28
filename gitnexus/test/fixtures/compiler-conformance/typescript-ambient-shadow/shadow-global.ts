interface GlobalEntry { local: number }
export function readLocal(entry: GlobalEntry) {
  return entry.local;
}
