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

export function field(value: { text: string }): void;
export function field(value: unknown): void;
export function field(value: unknown) {}

class WithText { read() {} }
class WithoutText { read() {} }
export function optionalField(value: { text?: string }): WithText;
export function optionalField(value: unknown): WithoutText;
export function optionalField(value: unknown): WithText | WithoutText { return new WithText(); }

export function admitsUndefined(value: { text?: undefined | string }): void;
export function admitsUndefined(value: unknown): void;
export function admitsUndefined(value: unknown) {}
