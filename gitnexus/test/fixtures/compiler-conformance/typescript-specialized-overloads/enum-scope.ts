enum Token { Open, Close }

export function outer(value: Token.Close) { return value; }

export function local() {
  enum Token { Open = 'open' }
  enum Token { Close = 'close' }
  function consume(value: Token.Open, other: Token.Close) { return value || other; }
  function route(value: Token.Open): number;
  function route(value: Token.Close): string;
  function route(value: Token): number | string { return value === Token.Open ? 1 : 'closed'; }
  return [consume(Token.Open, Token.Close), route(Token.Open), route(Token.Close)];
}
