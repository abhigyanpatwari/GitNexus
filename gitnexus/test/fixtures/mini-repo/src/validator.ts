export interface ValidationResult {
  valid: boolean;
  value: string;
}

export function validateInput(input: string): ValidationResult {
  if (!input || input.trim().length === 0) {
    return { valid: false, value: '' };
  }
  return { valid: true, value: input.trim() };
}

export function sanitize(input: string): string {
  return input.replace(/[<>]/g, '');
}
