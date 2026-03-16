import { validateInput } from './validator';
import { saveToDb } from './db';
import { formatResponse } from './formatter';

export class RequestHandler {
  async handleRequest(input: string): Promise<string> {
    const validated = validateInput(input);
    const saved = await saveToDb(validated);
    return formatResponse(saved);
  }
}

export function createHandler(): RequestHandler {
  return new RequestHandler();
}
