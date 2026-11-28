export function userText(input: string): string {
  return input.trim();
}

export async function* runCoachLoop(input: string): AsyncGenerator<string> {
  yield userText(input);
}
