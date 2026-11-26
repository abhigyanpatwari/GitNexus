import { Writer } from './writer.js';
export function caller() {
  const writer = new Writer();
  writer.close();
}
