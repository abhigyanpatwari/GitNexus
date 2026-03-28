/**
 * Workflow / State Machine Detection
 *
 * Detects:
 * 1. Status type definitions (union types, enums with status-like values)
 * 2. Status transition patterns (ORM update calls, direct assignments, setters)
 *
 * Supports TypeScript, JavaScript, Python, and Java patterns.
 */

export interface DetectedStatusType {
  /** Type name (e.g., 'GrantStatus', 'ApprovalInstanceStatus') */
  name: string;
  /** All possible status values */
  values: string[];
  /** Source file */
  filePath: string;
  /** Line number of the type definition */
  line: number;
  /** Whether it's a union type or enum */
  kind: 'union' | 'enum';
}

export interface DetectedTransition {
  /** Status value being set (e.g., 'ACTIVE', 'approved') */
  toStatus: string;
  /** Previous status if detectable from surrounding if-condition */
  fromStatus?: string;
  /** Entity/model being updated (e.g., 'grant', 'approvalStepInstance') */
  entityType?: string;
  /** Enclosing function name */
  functionName?: string;
  /** Source file */
  filePath: string;
  /** Line number */
  line: number;
  /** Whether inside a $transaction block */
  isTransactional?: boolean;
}

// Keywords that indicate a type is status/state-related
const STATUS_NAME_PATTERNS = /status|state|phase|stage|step|workflow|lifecycle/i;

// ORM patterns: prisma.model.update({ data: { status: 'value' } })
// Also matches: tx.model.update (transactional)
const PRISMA_UPDATE_PATTERN = /(?:prisma|tx)\.(\w+)\.update\s*\(\s*\{[\s\S]*?data\s*:\s*\{[\s\S]*?status\s*:\s*['"](\w+)['"]/g;

// Direct assignment: x.status = 'value' / this.status = 'approved' / self.status = 'active'
const STATUS_ASSIGNMENT_PATTERN = /(\w+)\.status\s*=\s*['"](\w+)['"]/g;

// Setter: setStatus('value') / set_status('value') / updateStatus('value') / changeStatus('value')
const STATUS_SETTER_PATTERN = /(?:(\w+)\.)?(?:set_?[Ss]tatus|updateStatus|changeStatus)\s*\(\s*['"](\w+)['"]/g;

// Generic .update() with status field: obj.update({ status: 'value' })
const GENERIC_UPDATE_PATTERN = /(\w+)\.update\s*\(\s*\{[\s\S]*?status\s*:\s*['"](\w+)['"]/g;

// Transaction wrapper detection
const TRANSACTION_PATTERN = /\$transaction\s*\(/;

// Function enclosure detection (simplified — finds nearest function name above a line)

/**
 * Extract status type definitions from file content.
 * Detects: `type XStatus = 'a' | 'b' | 'c'` and `enum XStatus { A = 'a', B = 'b' }`
 */
export function extractStatusTypes(content: string, language: string, filePath: string): DetectedStatusType[] {
  const supportedLanguages = ['typescript', 'javascript', 'python', 'java'];
  if (!supportedLanguages.includes(language)) return [];

  const results: DetectedStatusType[] = [];
  let match;

  // ── TypeScript / JavaScript patterns ──

  if (language === 'typescript' || language === 'javascript') {
    // Pattern 1: Union types — handles both single-line and multi-line:
    //   type FooStatus = 'a' | 'b' | 'c';
    //   type FooStatus =
    //     | 'a'
    //     | 'b';
    const unionPattern = /(?:export\s+)?type\s+(\w+)\s*=\s*([\s\S]*?);/g;
    while ((match = unionPattern.exec(content)) !== null) {
      const name = match[1];
      const valuesStr = match[2];
      const values = [...valuesStr.matchAll(/'([^']*)'/g)].map(m => m[1]);
      // Skip if no string literal values (not a string union)
      if (values.length < 2) continue;

      // Filter: must have status-related name OR status-like values
      if (!STATUS_NAME_PATTERNS.test(name) && !looksLikeStatusValues(values)) continue;

      const line = content.slice(0, match.index).split('\n').length;
      results.push({ name, values, filePath, line, kind: 'union' });
    }

    // Pattern 2: TS/JS Enums — enum FooStatus { A = 'a', B = 'b' }
    const enumPattern = /(?:export\s+)?enum\s+(\w+)\s*\{([^}]+)\}/g;
    while ((match = enumPattern.exec(content)) !== null) {
      const name = match[1];
      const body = match[2];

      if (!STATUS_NAME_PATTERNS.test(name)) continue;

      const values = [...body.matchAll(/=\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      if (values.length === 0) continue;

      const line = content.slice(0, match.index).split('\n').length;
      results.push({ name, values, filePath, line, kind: 'enum' });
    }
  }

  // ── Python patterns ──
  // class OrderStatus(Enum):
  //     PENDING = 'pending'
  //     SHIPPED = 'shipped'

  if (language === 'python') {
    const pyEnumPattern = /class\s+(\w+)\s*\(\s*(?:str\s*,\s*)?Enum\s*\)\s*:([\s\S]*?)(?=\nclass\s|\n[a-zA-Z]|$)/g;
    while ((match = pyEnumPattern.exec(content)) !== null) {
      const name = match[1];
      const body = match[2];

      if (!STATUS_NAME_PATTERNS.test(name) && !looksLikeStatusValues([])) {
        // Check if enum member names look like status values
        const memberNames = [...body.matchAll(/^\s+(\w+)\s*=/gm)].map(m => m[1]);
        if (!STATUS_NAME_PATTERNS.test(name) && !looksLikeStatusValues(memberNames.map(n => n.toLowerCase()))) continue;
      }

      // Extract string values: PENDING = 'pending'
      const stringValues = [...body.matchAll(/\w+\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      // If no string values, use the constant names themselves (e.g., auto())
      const values = stringValues.length > 0
        ? stringValues
        : [...body.matchAll(/^\s+(\w+)\s*=/gm)].map(m => m[1]);

      if (values.length === 0) continue;

      const line = content.slice(0, match.index).split('\n').length;
      results.push({ name, values, filePath, line, kind: 'enum' });
    }
  }

  // ── Java patterns ──
  // enum Status { PENDING, ACTIVE, COMPLETED }

  if (language === 'java') {
    const javaEnumPattern = /(?:public\s+)?enum\s+(\w+)\s*\{([^}]+)\}/g;
    while ((match = javaEnumPattern.exec(content)) !== null) {
      const name = match[1];
      const body = match[2];

      if (!STATUS_NAME_PATTERNS.test(name)) continue;

      // Java enums: extract comma-separated constant names (before any '(' or ';')
      const constantSection = body.split(';')[0];
      const values = constantSection
        .split(',')
        .map(v => v.trim())
        .filter(v => /^\w+$/.test(v) && v.length > 0);

      if (values.length === 0) continue;

      const line = content.slice(0, match.index).split('\n').length;
      results.push({ name, values, filePath, line, kind: 'enum' });
    }
  }

  return results;
}

/**
 * Extract status transitions from file content.
 * Detects ORM updates, direct assignments, setter calls, and generic .update() patterns.
 */
export function extractStatusTransitions(content: string, language: string, filePath: string): DetectedTransition[] {
  const supportedLanguages = ['typescript', 'javascript', 'python', 'java'];
  if (!supportedLanguages.includes(language)) return [];

  const results: DetectedTransition[] = [];

  // Helper to build a transition from a match
  const addTransition = (entityType: string, toStatus: string, matchIndex: number) => {
    const line = content.slice(0, matchIndex).split('\n').length;
    const precedingContent = content.slice(Math.max(0, matchIndex - 500), matchIndex);
    const isTransactional = TRANSACTION_PATTERN.test(precedingContent);
    const fromStatus = findPrecedingStatusCheck(content, matchIndex);
    const functionName = findEnclosingFunction(content, matchIndex);

    results.push({
      toStatus,
      fromStatus: fromStatus || undefined,
      entityType,
      functionName: functionName || undefined,
      filePath,
      line,
      isTransactional: isTransactional || undefined,
    });
  };

  // Track matched status values by line to avoid duplicates (e.g., generic .update overlapping with Prisma)
  const matchedLines = new Set<string>();
  const addUnique = (entityType: string, toStatus: string, matchIndex: number) => {
    const line = content.slice(0, matchIndex).split('\n').length;
    const key = `${line}:${toStatus}`;
    if (matchedLines.has(key)) return;
    matchedLines.add(key);
    addTransition(entityType, toStatus, matchIndex);
  };

  let match;

  // ── Prisma ORM pattern ──
  PRISMA_UPDATE_PATTERN.lastIndex = 0;
  while ((match = PRISMA_UPDATE_PATTERN.exec(content)) !== null) {
    addUnique(match[1], match[2], match.index);
  }

  // ── Direct assignment: x.status = 'value' ──
  STATUS_ASSIGNMENT_PATTERN.lastIndex = 0;
  while ((match = STATUS_ASSIGNMENT_PATTERN.exec(content)) !== null) {
    addUnique(match[1], match[2], match.index);
  }

  // ── Setter pattern: obj.setStatus('value') ──
  STATUS_SETTER_PATTERN.lastIndex = 0;
  while ((match = STATUS_SETTER_PATTERN.exec(content)) !== null) {
    const entityType = match[1] || 'unknown';
    addUnique(entityType, match[2], match.index);
  }

  // ── Generic .update({ status: 'value' }) — skip prisma/tx to avoid duplicates ──
  GENERIC_UPDATE_PATTERN.lastIndex = 0;
  while ((match = GENERIC_UPDATE_PATTERN.exec(content)) !== null) {
    // Skip if it's a prisma chained call (already caught above)
    const preceding = content.slice(Math.max(0, match.index - 50), match.index);
    if (/(?:prisma|tx)\.\w+\.$/.test(preceding)) continue;
    addUnique(match[1], match[2], match.index);
  }

  return results;
}

// ── Helpers ──

function looksLikeStatusValues(values: string[]): boolean {
  if (values.length < 2) return false;
  const statusKeywords = /^(draft|active|pending|approved|rejected|completed|cancelled|closed|on.?hold|in.?progress|not.?started|failed|running|paused|blocked|todo|done|shipped|delivered|processing|escalated|skipped)/i;
  const matchCount = values.filter(v => statusKeywords.test(v)).length;
  return matchCount >= 2; // At least 2 values look like statuses
}

function findPrecedingStatusCheck(content: string, beforeIndex: number): string | null {
  // Look back up to 500 chars but don't cross function boundaries
  const windowStart = Math.max(0, beforeIndex - 500);
  let window = content.slice(windowStart, beforeIndex);

  // Trim window at the last function declaration to stay within scope
  const funcBoundary = /(?:async\s+)?function\s+\w+|(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(/g;
  let lastBoundaryIndex = -1;
  let m;
  while ((m = funcBoundary.exec(window)) !== null) {
    lastBoundaryIndex = m.index;
  }
  if (lastBoundaryIndex > 0) {
    window = window.slice(lastBoundaryIndex);
  }

  const checks = [...window.matchAll(/\.status\s*===?\s*['"](\w+)['"]|status\s*===?\s*['"](\w+)['"]/g)];
  if (checks.length === 0) return null;
  // Return the last (closest) check
  const last = checks[checks.length - 1];
  return last[1] || last[2];
}

function findEnclosingFunction(content: string, beforeIndex: number): string | null {
  const window = content.slice(Math.max(0, beforeIndex - 2000), beforeIndex);
  const pattern = /(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  let lastMatch: string | null = null;
  let match;
  while ((match = pattern.exec(window)) !== null) {
    lastMatch = match[1] || match[2];
  }
  return lastMatch;
}
