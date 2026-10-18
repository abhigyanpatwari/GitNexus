import { Writer } from './writer';
export function useImported(): void {
  const writer = new Writer();
  writer.close();
}
