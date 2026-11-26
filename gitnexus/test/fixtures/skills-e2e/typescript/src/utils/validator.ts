
export function validateRequest(input: string) {
  if (!input || input.length === 0) throw new Error('Invalid');
  return true;
}

export function validateToken(token: string) {
  if (!token || token.length < 10) throw new Error('Invalid token');
  return true;
}

export function sanitize(input: string) {
  return input.replace(/[<>]/g, '');
}
