namespace Members {
  export class Visible { run() {} }
  class Private { run() {} }
}
export function visible(value: Members.Visible) { value.run(); }
export function hidden(value: Members.Private) { value.run(); }

declare namespace Ambient {
  class Service { run(): void }
}
export function declared(value: Ambient.Service) { value.run(); }
