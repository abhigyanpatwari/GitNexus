export class Service { ping(): Service { return this; } }
export function caller(service: Service) {
  service.ping().ping();
}
