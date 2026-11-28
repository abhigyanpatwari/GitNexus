import { admitsUndefined, field, literal, optionalField, pick, Service } from './signature';
export function strict(service: Service) {
  pick(null);
  pick(undefined);
  service.pick(null);
  service.pick(undefined);
  literal(null);
  field({ text: null });
  field({ text: undefined });
}

export function defaultOptionalFields() {
  const result = optionalField({ text: undefined });
  result.read();
  optionalField({});
  optionalField({ text: null });
  admitsUndefined({ text: undefined });
}
