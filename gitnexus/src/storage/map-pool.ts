/** Rolling worker pool: in-order results, fail-fast mapper errors. */
export const mapPool = async <T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> => {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );
  return results;
};
