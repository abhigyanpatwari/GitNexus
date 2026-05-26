import type { EvolutionMemoryRecord } from './types.js';

export class InMemoryEvolutionMemory {
  private records: EvolutionMemoryRecord[] = [];

  add(record: EvolutionMemoryRecord): void {
    this.records.push(structuredClone(record));
  }

  queryByKind(kind: EvolutionMemoryRecord['kind']): EvolutionMemoryRecord[] {
    return this.records.filter((r) => r.kind === kind).map((r) => structuredClone(r));
  }

  queryByGoalId(goalId: string): EvolutionMemoryRecord[] {
    return this.records
      .filter((r) => r.goalId === goalId)
      .map((r) => structuredClone(r));
  }

  queryByVariantId(variantId: string): EvolutionMemoryRecord[] {
    return this.records
      .filter((r) => r.variantId === variantId)
      .map((r) => structuredClone(r));
  }
}
