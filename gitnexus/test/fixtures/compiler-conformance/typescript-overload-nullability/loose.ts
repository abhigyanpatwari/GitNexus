import { field, literal, optionalField, pick, primitive, Service } from './signature';
export function loose(service: Service) {
  pick(null);
  pick(undefined);
  service.pick(null);
  service.pick(undefined);
  literal(null);
  literal(undefined);
  primitive(null);
  primitive(undefined);
  field({ text: null });
  field({ text: undefined });
  optionalField({ text: undefined });
}

export function fieldControls() {
  field({ text: 42 });
  field({ text: "ok" });
}

export function shadowed(undefined: number) {
  field({ text: undefined });
  optionalField({ text: undefined });
}
