export class Config {
  validate(): boolean { return true; }
}
export function getConfig(): Config {
  return new Config();
}
