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

enum Bits { Mask = 1 << 2, Next, Alias = (Bits.Next | Mask) }
function decode(flag: Bits.Mask): number;
function decode(flag: Bits.Next): string;
function decode(flag: Bits): number | string { return flag === Bits.Mask ? 0 : 'next'; }
export function decodeFlags() { decode(Bits.Next); decode(Bits.Alias); }
