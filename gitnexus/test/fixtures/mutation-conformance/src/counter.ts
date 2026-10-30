// Stryker disable all
// Conformance fixture (gate 2): module-level state that would show carry-over between two
// mutant runs in one runner process.

let issued = 0;
let lastLabel = '';

export function nextTicket(): number {
  // Stryker restore next-line AssignmentOperator
  issued += 1;
  // Stryker restore next-line StringLiteral
  lastLabel = `ticket ${issued}`;
  return issued;
}

export function lastTicketLabel(): string {
  return lastLabel;
}
