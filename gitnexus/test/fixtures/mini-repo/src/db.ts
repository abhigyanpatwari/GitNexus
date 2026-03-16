import type { ValidationResult } from './validator';

export interface DbRecord {
  id: string;
  value: string;
  timestamp: number;
}

export async function saveToDb(input: ValidationResult): Promise<DbRecord> {
  return {
    id: Math.random().toString(36),
    value: input.value,
    timestamp: Date.now(),
  };
}

export async function findById(id: string): Promise<DbRecord | null> {
  return null;
}
