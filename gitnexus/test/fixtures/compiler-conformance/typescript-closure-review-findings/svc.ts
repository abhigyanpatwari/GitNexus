export class Port { send(): void {} }
export class Service {
  constructor(private readonly port: Port) {}
}
