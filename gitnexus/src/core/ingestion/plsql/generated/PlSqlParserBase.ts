import { Parser, TokenStream, CommonTokenStream, Token } from 'antlr4ng';
import { PlSqlLexer } from './PlSqlLexer.js';

export abstract class PlSqlParserBase extends Parser {

  _isVersion10: boolean;
  _isVersion11: boolean;
  _isVersion12: boolean;
  _lastUnitWasPlsql: boolean;

  constructor(input: TokenStream) {
    super(input);
    this._isVersion10 = true;
    this._isVersion11 = true;
    this._isVersion12 = true;
    this._lastUnitWasPlsql = false;
  }

  reset(): void {
    this._lastUnitWasPlsql = false;
    super.reset();
  }

  setLastUnitPlsql(): void { this._lastUnitWasPlsql = true; }
  setLastUnitSql(): void   { this._lastUnitWasPlsql = false; }
  isLastUnitSql(): boolean { return !this._lastUnitWasPlsql; }
  isLastUnitPlsql(): boolean { return this._lastUnitWasPlsql; }

  isSolidusSeparator(): boolean {
    const stream = this.tokenStream as CommonTokenStream;
    const solidus = stream.LT(1);
    if (solidus == null || solidus!.type !== PlSqlLexer.SOLIDUS)
      return false;

    const solidusLine = solidus!.line;

    const prev = stream.LT(-1);
    if (prev != null && prev!.type !== Token.EOF && prev!.line === solidusLine)
      return false;

    const next = stream.LT(2);
    if (next != null && next!.type !== Token.EOF && next!.line === solidusLine)
      return false;

    return true;
  }

  /** True when the current token is the first significant token on its line. */
  isLineStart(): boolean {
    const stream = this.tokenStream as CommonTokenStream;
    const token = stream.LT(1);
    if (token == null) {
      return false;
    }

    const prev = stream.LT(-1);
    if (prev == null || prev.type === Token.EOF) {
      return true;
    }

    return prev.line < token.line;
  }

  isVersion10(): boolean {
    return this._isVersion10;
  }

  isVersion11(): boolean {
    return this._isVersion11;
  }

  isVersion12(): boolean {
    return this._isVersion12;
  }

  setVersion10(value: boolean): void {
    this._isVersion10 = value;
  }

  setVersion11(value: boolean): void {
    this._isVersion11 = value;
  }

  setVersion12(value: boolean): void {
    this._isVersion12 = value;
  }

  IsNotNumericFunction(): boolean {
    const lt1 = (this.tokenStream as CommonTokenStream).LT(1);
    const lt2 = (this.tokenStream as CommonTokenStream).LT(2);
    if ((lt1!.type === PlSqlLexer.SUM ||
      lt1!.type === PlSqlLexer.COUNT ||
      lt1!.type === PlSqlLexer.AVG ||
      lt1!.type === PlSqlLexer.MIN ||
      lt1!.type === PlSqlLexer.MAX ||
      lt1!.type === PlSqlLexer.ROUND ||
      lt1!.type === PlSqlLexer.LEAST ||
      lt1!.type === PlSqlLexer.GREATEST) && lt2!.type === PlSqlLexer.LEFT_PAREN)
      return false;
    return true;
  }

  isNotStartOfJoin(): boolean {
    const lt1 = (this.tokenStream as CommonTokenStream).LT(1);
    if (lt1!.type == PlSqlLexer.INNER ||
        lt1!.type == PlSqlLexer.CROSS ||
        lt1!.type == PlSqlLexer.NATURAL ||
        lt1!.type == PlSqlLexer.PARTITION ||
        lt1!.type == PlSqlLexer.FULL ||
        lt1!.type == PlSqlLexer.LEFT ||
        lt1!.type == PlSqlLexer.RIGHT ||
        lt1!.type == PlSqlLexer.OUTER)
        return false;
    return true;
  }

}
