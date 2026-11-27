import { field, literal, pick, Service } from './signature';
export function strict(service: Service) {
  pick(null);
  pick(undefined);
  service.pick(null);
  service.pick(undefined);
  literal(null);
  field({ text: null });
  field({ text: undefined });
}
