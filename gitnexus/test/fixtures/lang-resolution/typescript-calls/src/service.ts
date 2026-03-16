import { writeAudit } from './one';
import { writeAudit as zeroWriteAudit } from './zero';

export function run(): string {
  return writeAudit('hello');
}
