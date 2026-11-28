import { route, Token as Imported } from './enum';
import * as tokens from './enum';

export function fromAlias(value: Imported.Open): tokens.Token.Close {
  route(Imported.Open);
  return tokens.Token.Close;
}
