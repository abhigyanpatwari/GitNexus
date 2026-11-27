export function pick(value: string): void;
export function pick(value: number | null | undefined): void;
export function pick(value: unknown) {}

export class Service {
  pick(value: never): void;
  pick(value: string): void;
  pick(value: number | null | undefined): void;
  pick(value: unknown) {}
}

export function primitive(value: string): void;
export function primitive(value: number): void;
export function primitive(value: unknown) {}

export function literal(value: string): void;
export function literal(value: null): void;
export function literal(value: unknown) {}
