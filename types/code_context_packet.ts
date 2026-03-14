/**
 * TypeScript 型別定義 - Code Context Packet v1
 * 
 * 基於 JSON Schema 自動生成的型別定義
 * 用於 AI agents 間的結構化程式碼上下文傳遞
 */

export type ContextType = 
  | 'symbol_context'
  | 'impact_analysis' 
  | 'search_results'
  | 'execution_flow'
  | 'dependency_graph'
  | 'refactor_plan';

export type QueryIntent = 
  | 'explore'
  | 'understand'
  | 'modify'
  | 'debug'
  | 'refactor'
  | 'impact_assess';

export type SymbolType = 
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'constant'
  | 'interface'
  | 'type';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ImpactType = 
  | 'direct_caller'
  | 'indirect_caller'
  | 'data_flow'
  | 'control_flow';

export type MatchType = 'exact' | 'semantic' | 'fuzzy';

export type RelationshipType = 
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'uses';

export type OperationType = 
  | 'rename'
  | 'move'
  | 'extract'
  | 'inline'
  | 'split';

export interface LineRange {
  start: number;
  end: number;
}

export interface SymbolReference {
  name: string;
  type: string;
  file_path: string;
  line_range?: LineRange;
}

export interface PacketSource {
  tool: 'gitnexus' | 'sourcegraph' | 'github_copilot' | 'cursor' | 'claude_code' | 'custom';
  agent_id: string;
  session_id?: string;
}

export interface QueryInfo {
  original_query: string;
  normalized_query?: string;
  intent?: QueryIntent;
}

export interface RepositoryInfo {
  name: string;
  commit_hash?: string;
  branch?: string;
}

export interface PacketMetadata {
  confidence_score?: number;
  token_cost?: number;
  processing_time_ms?: number;
  cache_hit?: boolean;
}

// 上下文資料型別定義
export interface SymbolContextData {
  symbol: {
    name: string;
    type: SymbolType;
    file_path: string;
    line_range?: LineRange;
  };
  dependencies: SymbolReference[];
  dependents: SymbolReference[];
  processes: string[];
}

export interface ImpactAnalysisData {
  target_symbol: SymbolReference;
  risk_level: RiskLevel;
  affected_symbols: Array<{
    symbol: SymbolReference;
    impact_type: ImpactType;
    depth: number;
  }>;
}

export interface SearchResultsData {
  results: Array<{
    symbol: SymbolReference;
    relevance_score: number;
    match_type?: MatchType;
    context_snippet?: string;
  }>;
}

export interface ExecutionFlowData {
  flow_name: string;
  steps: Array<{
    step_id: number;
    symbol: SymbolReference;
    action: string;
    conditions?: string[];
  }>;
}

export interface DependencyGraphData {
  nodes: SymbolReference[];
  edges: Array<{
    from: string;
    to: string;
    relationship: RelationshipType;
  }>;
}

export interface RefactorPlanData {
  plan_id: string;
  operations: Array<{
    operation_type: OperationType;
    target: SymbolReference;
    new_name?: string;
    new_location?: string;
  }>;
}

// 主要封包介面
export interface CodeContextPacket {
  packet_id: string;
  version: '1.0';
  source: PacketSource;
  timestamp: string;
  context_type: ContextType;
  query?: QueryInfo;
  repository?: RepositoryInfo;
  data: SymbolContextData | ImpactAnalysisData | SearchResultsData | 
        ExecutionFlowData | DependencyGraphData | RefactorPlanData;
  metadata?: PacketMetadata;
  summary?: string;
  ai_instructions?: string;
}

// 工具函式型別定義
export interface PacketValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ContextCacheOptions {
  ttl?: number;  // 存活時間（毫秒）
  maxSize?: number;  // 最大快取大小
  compression?: boolean;  // 是否壓縮
}

export interface QueryOptions {
  contextType?: ContextType;
  repository?: string;
  maxAge?: number;  // 最大年齡（毫秒）
  limit?: number;
  includeExpired?: boolean;
}

// 工具函式介面
export interface ContextPacketUtils {
  createPacket(
    contextType: ContextType,
    data: any,
    query: string,
    intent: QueryIntent,
    options?: Partial<CodeContextPacket>
  ): CodeContextPacket;
  
  validatePacket(packet: any): PacketValidationResult;
  
  storePacket(packet: CodeContextPacket, options?: ContextCacheOptions): Promise<void>;
  
  loadPackets(options: QueryOptions): Promise<CodeContextPacket[]>;
  
  findRelevantPackets(query: string, contextType?: ContextType): Promise<CodeContextPacket[]>;
  
  cleanExpiredPackets(): Promise<number>;
}

// 傳遞機制介面
export interface ContextTransferMechanism {
  name: string;
  
  send(packet: CodeContextPacket): Promise<string>;  // 返回傳送 ID
  
  receive(id: string): Promise<CodeContextPacket | null>;
  
  query(options: QueryOptions): Promise<CodeContextPacket[]>;
  
  isAvailable(): boolean;
}

// 效能監控介面
export interface ContextMetrics {
  packetsCreated: number;
  packetsReused: number;
  cacheHitRate: number;
  averagePacketSize: number;
  transferLatency: number[];
  
  efficiency: number;  // 重用率
  totalSavings: number;  // 節省的 token 數
}

export interface MetricsCollector {
  recordPacketCreation(packet: CodeContextPacket): void;
  recordPacketReuse(packetId: string): void;
  recordTransferLatency(latency: number): void;
  getMetrics(): ContextMetrics;
  reset(): void;
}

// 錯誤型別定義
export class ContextPacketError extends Error {
  constructor(
    message: string,
    public code: string,
    public packet?: CodeContextPacket
  ) {
    super(message);
    this.name = 'ContextPacketError';
  }
}

export class ValidationError extends ContextPacketError {
  constructor(message: string, public validationErrors: string[]) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class TransferError extends ContextPacketError {
  constructor(message: string, public mechanism: string) {
    super(message, 'TRANSFER_ERROR');
  }
}

// 常數定義
export const PACKET_VERSION = '1.0' as const;
export const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 小時
export const MAX_PACKET_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_CACHE_SIZE = 1000; // 最大快取封包數

// 型別守衛函式
export function isSymbolContextData(data: any): data is SymbolContextData {
  return data && typeof data.symbol === 'object' && Array.isArray(data.dependencies);
}

export function isImpactAnalysisData(data: any): data is ImpactAnalysisData {
  return data && data.target_symbol && data.risk_level && Array.isArray(data.affected_symbols);
}

export function isValidPacket(packet: any): packet is CodeContextPacket {
  return packet && 
         typeof packet.packet_id === 'string' &&
         packet.version === '1.0' &&
         typeof packet.source === 'object' &&
         typeof packet.timestamp === 'string' &&
         typeof packet.context_type === 'string' &&
         packet.data !== undefined;
}
