import { admitsUndefined, optionalField } from './signature';

export function exactFields() {
  const result = optionalField({ text: undefined });
  result.read();
  optionalField({});
  optionalField({ text: 'value' });
  admitsUndefined({ text: undefined });
}

export function shadowed(undefined: string) {
  optionalField({ text: undefined });
}
