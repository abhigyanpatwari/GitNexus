
export function validate(input: string) {
  if (!input) throw new Error('Invalid');
  return true;
}

export function checkSchema(schema: any) {
  return schema && typeof schema === 'object';
}

export function sanitize(input: string) {
  return input.replace(/[<>]/g, '');
}
