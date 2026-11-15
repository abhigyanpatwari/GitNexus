// Scenario-map controls fixture (Phase 1 U17), pair `order-dependent`. Module-level state: every
// label depends on how many tickets earlier code in the same module instance issued.

let issued = 0;

/** Labels the next ticket of a queue with a process-wide running number. */
export function nextTicketLabel(queue: string): string {
  issued += 1;
  return `${queue}-${issued}`;
}
