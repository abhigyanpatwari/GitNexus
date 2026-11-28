export interface Reader<T> {
  read(value: T): void;
}
export interface TextReader extends Reader<string> {
  read(value: string): void;
}
export interface Alternate extends Reader<string> {}
export interface Joined extends TextReader, Alternate {}
export class TextLog implements Joined {
  read(value: string) {}
}
export interface Flipped extends Alternate, TextReader {}
export function first(value: Joined) { value.read('x'); }
export function second(value: Flipped) { value.read('x'); }
