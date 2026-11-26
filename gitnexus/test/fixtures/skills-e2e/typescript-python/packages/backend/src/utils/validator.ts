
export function validateRequest(input: string) {
  if (!input) throw new Error('Invalid');
  return true;
}

export function sanitize(input: string) {
  return input.replace(/[<>]/g, '');
}
