/** Conventional production source roots cannot see test or other source sets.
 * Unknown/custom layouts retain their existing eligibility; this is not a
 * build-system classpath model. */
export function isJvmSourceVisible(fromFile: string, candidateFile: string): boolean {
  const sourceSet = (file: string) =>
    /(?:^|\/)src\/([^/]+)\/(?:java|kotlin)(?:\/|$)/.exec(file.replace(/\\/g, '/'))?.[1];
  return (
    sourceSet(fromFile) !== 'main' ||
    sourceSet(candidateFile) === undefined ||
    sourceSet(candidateFile) === 'main'
  );
}
