import { Writer } from './writer';
export function useImported(writer: Writer): void {
  writer.close();
}
