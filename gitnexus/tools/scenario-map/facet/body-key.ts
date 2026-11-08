/**
 * Retrieval hint only: the same callback body can occur behind different hooks or imports.
 * It proves neither equal context nor equal input. Verdicts still require all runtime gates.
 */
import type { CaseRecord } from '../../test-dupes/test-dupes.js';
import { sha1 } from '../util.js';

export const bodyKeyOf = (record: CaseRecord): string => sha1(record.body);
