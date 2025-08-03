import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type LLMProvider = 'openai' | 'anthropic' | 'gemini';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

export interface ChatResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
  finishReason?: string;
}

export class LLMService {
  private models: Map<string, BaseChatModel> = new Map();
  private defaultConfig: Partial<LLMConfig> = {
    temperature: 0.1,
    maxTokens: 4000,
    maxRetries: 3
  };

  // Default models for each provider
  private static readonly DEFAULT_MODELS: Record<LLMProvider, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-haiku-20240307',
    gemini: 'gemini-1.5-flash'
  };

  constructor() {}

  /**
   * Initialize or get a chat model for the specified provider
   */
  public getChatModel(config: LLMConfig): BaseChatModel {
    const cacheKey = this.getCacheKey(config);
    
    if (this.models.has(cacheKey)) {
      return this.models.get(cacheKey)!;
    }

    const model = this.createChatModel(config);
    this.models.set(cacheKey, model);
    return model;
  }

  /**
   * Send a chat message and get a response
   */
  public async chat(
    config: LLMConfig,
    messages: BaseMessage[],
    options?: { stream?: boolean }
  ): Promise<ChatResponse> {
    try {
      const model = this.getChatModel(config);
      
      if (options?.stream) {
        // For streaming, we'd need to handle this differently
        // For now, we'll just use regular invoke
        console.warn('Streaming not implemented yet, falling back to regular invoke');
      }

      const response = await model.invoke(messages);
      
      return {
        content: response.content as string,
        usage: response.response_metadata?.usage ? {
          promptTokens: response.response_metadata.usage.prompt_tokens || 0,
          completionTokens: response.response_metadata.usage.completion_tokens || 0,
          totalTokens: response.response_metadata.usage.total_tokens || 0
        } : undefined,
        model: config.model || LLMService.DEFAULT_MODELS[config.provider],
        finishReason: response.response_metadata?.finish_reason
      };
    } catch (error) {
      throw new Error(`LLM chat failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate API key format for different providers
   */
  public validateApiKey(provider: LLMProvider, apiKey: string): boolean {
    if (!apiKey || apiKey.trim().length === 0) {
      return false;
    }

    switch (provider) {
      case 'openai':
        return apiKey.startsWith('sk-') && apiKey.length > 20;
      case 'anthropic':
        return apiKey.startsWith('sk-ant-') && apiKey.length > 20;
      case 'gemini':
        return apiKey.length > 20; // Google API keys don't have a consistent prefix
      default:
        return false;
    }
  }

  /**
   * Get available models for a provider
   */
  public getAvailableModels(provider: LLMProvider): string[] {
    switch (provider) {
      case 'openai':
        return [
          'gpt-4o',
          'gpt-4o-mini',
          'gpt-4-turbo',
          'gpt-4',
          'gpt-3.5-turbo'
        ];
      case 'anthropic':
        return [
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307'
        ];
      case 'gemini':
        return [
          'gemini-1.5-pro',
          'gemini-1.5-flash',
          'gemini-1.0-pro'
        ];
      default:
        return [];
    }
  }

  /**
   * Get provider display name
   */
  public getProviderDisplayName(provider: LLMProvider): string {
    switch (provider) {
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      case 'gemini':
        return 'Google Gemini';
      default:
        return provider;
    }
  }

  /**
   * Test connection with the provider
   */
  public async testConnection(config: LLMConfig): Promise<{ success: boolean; error?: string }> {
    try {
      const model = this.createChatModel(config);
      
      // Send a simple test message
      const testMessages = [{
        role: 'user' as const,
        content: 'Hello, this is a connection test. Please respond with "OK".'
      }];

      const response = await model.invoke(testMessages);
      
      return {
        success: true
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed'
      };
    }
  }

  /**
   * Clear cached models (useful for updating API keys)
   */
  public clearCache(): void {
    this.models.clear();
  }

  /**
   * Create a chat model instance based on the provider
   */
  private createChatModel(config: LLMConfig): BaseChatModel {
    const mergedConfig = { ...this.defaultConfig, ...config };
    const model = mergedConfig.model || LLMService.DEFAULT_MODELS[config.provider];

    switch (config.provider) {
      case 'openai':
        return new ChatOpenAI({
          apiKey: config.apiKey,
          model,
          temperature: mergedConfig.temperature,
          maxTokens: mergedConfig.maxTokens,
          maxRetries: mergedConfig.maxRetries,
          timeout: 30000
        });

      case 'anthropic':
        return new ChatAnthropic({
          apiKey: config.apiKey,
          model,
          temperature: mergedConfig.temperature,
          maxTokens: mergedConfig.maxTokens,
          maxRetries: mergedConfig.maxRetries,
          timeout: 30000
        });

      case 'gemini':
        return new ChatGoogleGenerativeAI({
          apiKey: config.apiKey,
          model,
          temperature: mergedConfig.temperature,
          maxOutputTokens: mergedConfig.maxTokens,
          maxRetries: mergedConfig.maxRetries
        });

      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
  }

  /**
   * Generate cache key for model instances
   */
  private getCacheKey(config: LLMConfig): string {
    const model = config.model || LLMService.DEFAULT_MODELS[config.provider];
    return `${config.provider}:${model}:${config.apiKey.slice(-8)}:${config.temperature}:${config.maxTokens}`;
  }
} 
