export interface Plugin {
  name: string;
  version: string;
  description?: string;
  init?(config: Record<string, any>): Promise<void>;
  dispose?(): Promise<void>;
}

export interface ParserRegistry {
  registerParser(parser: ParserPlugin): void;
  getParser(filePath: string): ParserPlugin | undefined;
  getParsers(): ParserPlugin[];
  unregisterParser(name: string): void;
}

export interface AnalyzerRegistry {
  registerAnalyzer(analyzer: AnalyzerPlugin): void;
  getAnalyzers(language?: string): AnalyzerPlugin[];
  unregisterAnalyzer(name: string): void;
}

export interface ParserPlugin extends Plugin {
  extensions: string[];
  parse(content: string, filePath: string): Promise<ParseResult>;
  register(registry: ParserRegistry | AnalyzerRegistry): void;
  supports(filePath: string): boolean;
}

export interface AnalyzerPlugin extends Plugin {
  languages: string[];
  analyze(node: any, context: AnalysisContext): Promise<AnalysisResult>;
  register(registry: ParserRegistry | AnalyzerRegistry): void;
  supports(language: string): boolean;
}

export interface ParseResult {
  nodes: any[];
  edges: any[];
  metadata: Record<string, any>;
  error?: string;
}

export interface AnalysisContext {
  filePath: string;
  language: string;
  semanticModel: any;
  parser: any;
  config: Record<string, any>;
}

export interface AnalysisResultItem {
  type: string;
  name?: string;
  [key: string]: any;
}

export interface AnalysisResult {
  results: AnalysisResultItem[];
  metadata: Record<string, any>;
}
