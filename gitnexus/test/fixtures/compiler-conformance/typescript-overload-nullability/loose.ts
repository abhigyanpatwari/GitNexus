import { literal, pick, primitive, Service } from './signature';
export function loose(service: Service) {
  pick(null);
  pick(undefined);
  service.pick(null);
  service.pick(undefined);
  literal(null);
  literal(undefined);
  primitive(null);
  primitive(undefined);
}
