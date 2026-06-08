// gitnexus/src/core/coverage/parsers/cobertura.ts
import type { CanonicalCoverage, CoverageRunMeta, FileCoverage } from '../types.js';

/**
 * Parse Cobertura XML coverage format into CanonicalCoverage.
 *
 * Cobertura XML is used by:
 *   - Java (Cobertura, JaCoCo XML report format)
 *   - Python (coverage.py XML report)
 *   - .NET (OpenCover, dotCover)
 *   - Rust (cargo-tarpaulin)
 *
 * Basic structure:
 *   <coverage>
 *     <packages>
 *       <package name="..." line-rate="..." branch-rate="...">
 *         <classes>
 *           <class name="..." filename="..." line-rate="..." branch-rate="...">
 *             <methods>
 *               <method name="..." signature="...">
 *                 <lines>
 *                   <line number="142" hits="5" branch="true" condition-coverage="50% (1/2)"/>
 *                 </lines>
 *               </method>
 *             </methods>
 *             <lines>
 *               <line number="10" hits="3"/>
 *             </lines>
 *           </class>
 *         </classes>
 *       </package>
 *     </packages>
 *   </coverage>
 */
export function parseCobertura(input: string, meta: CoverageRunMeta): CanonicalCoverage {
  const files: Record<string, FileCoverage> = {};
  let totalLines = 0;
  let coveredLines = 0;

  // Simple XML parsing without external dependencies.
  // We use regex-based extraction since the Cobertura format is well-structured
  // and we only need a few attributes.

  // Extract all <class> elements
  const classRegex = /<class\s+[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classRegex.exec(input)) !== null) {
    const filePath = classMatch[1];
    const classBody = classMatch[2];
    const fileCov: FileCoverage = { lines: {}, branches: {} };

    // Extract <line> elements (both top-level and inside <methods>)
    const lineRegex = /<line\s+number="(\d+)"\s+hits="(\d+)"(?:\s+branch="([^"]*)")?(?:\s+condition-coverage="[^"]*?\((\d+)\/(\d+)\)")?[^/]*\/>/g;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineRegex.exec(classBody)) !== null) {
      const lineNum = lineMatch[1];
      const hits = parseInt(lineMatch[2], 10);
      const isBranch = lineMatch[3] === 'true';
      const branchCovered = lineMatch[4] ? parseInt(lineMatch[4], 10) : undefined;
      const branchTotal = lineMatch[5] ? parseInt(lineMatch[5], 10) : undefined;

      fileCov.lines[lineNum] = (fileCov.lines[lineNum] ?? 0) + hits;
      totalLines++;
      if (hits > 0) coveredLines++;

      // Parse branch coverage from condition-coverage attribute
      if (isBranch && branchTotal !== undefined && branchCovered !== undefined) {
        // Record each branch: covered branches get hitCount=1, uncovered get 0
        const branchId = `${lineNum}:0`;
        fileCov.branches![branchId] = branchCovered;
        if (branchTotal > 1) {
          const uncoveredBranches = branchTotal - branchCovered;
          const branchId2 = `${lineNum}:1`;
          fileCov.branches![branchId2] = uncoveredBranches > 0 ? 0 : 1;
        }
      }
    }

    if (Object.keys(fileCov.lines).length > 0) {
      files[filePath] = fileCov;
    }
  }

  return {
    format: 'gitnexus-coverage-v1',
    run: {
      ...meta,
      totalLines,
      coveredLines,
    },
    files,
  };
}
