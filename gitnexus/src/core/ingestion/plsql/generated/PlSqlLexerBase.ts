import { CommonToken, Lexer, CharStream, Token, CommonTokenStream } from "antlr4ng";

export abstract class PlSqlLexerBase extends Lexer {
  IsNewlineAtPos(pos: number): boolean {
    const la = this.inputStream.LA(pos);
    return la == -1 || String.fromCharCode(la) == '\n';
  }

  IsQQuoteDelimiter(): boolean {
    const opening = this.inputStream.LA(this.tokenStartCharIndex + 2 - this.inputStream.index);
    const closing = this.inputStream.LA(-2);
    switch (opening) {
      case 91: return closing == 93;
      case 123: return closing == 125;
      case 60: return closing == 62;
      case 40: return closing == 41;
      default: return closing == opening;
    }
  }

}
