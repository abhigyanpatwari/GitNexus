/**
 * LLM Module Exports
 *
 * Provides Graph RAG agent capabilities for code analysis.
 */

// Types
export * from './types';

// Settings management
export {
  loadSettings,
  saveSettings,
  updateProviderSettings,
  setActiveProvider,
  getActiveProviderConfig,
  isProviderConfigured,
  clearSettings,
  getProviderDisplayName,
  getAvailableModels,
  getAgentConfig,
  getModelNameForSettings,
  normalizeMaxIterations,
  normalizeTokenBudget,
} from './settings-service';

// Pricing & Usage Formatting
export {
  getModelPricing,
  estimateCostUsd,
  formatCostUsd,
  formatTokenCount,
  type ModelPricing,
} from './pricing';

// Tools
export { createGraphRAGTools } from './tools';

// Context Builder
export {
  buildCodebaseContext,
  formatContextForPrompt,
  buildDynamicSystemPrompt,
  type CodebaseContext,
  type CodebaseStats,
  type Hotspot,
} from './context-builder';

// Agent
export {
  createChatModel,
  createGraphRAGAgent,
  streamAgentResponse,
  invokeAgent,
  toRecursionLimit,
  extractMessageUsage,
  BASE_SYSTEM_PROMPT,
  type AgentMessage,
} from './agent';
