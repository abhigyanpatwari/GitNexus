export enum Token {
  Open = -0x1,
  Close,
}

export function route(token: Token.Open): number;
export function route(token: Token.Close): string;
export function route(token: Token): number | string {
  return token === Token.Open ? 1 : 'closed';
}

export function local() {
  return route(Token.Close);
}
