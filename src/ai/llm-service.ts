import { ChatOpenAI } from '@langchain/openai';
import { AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';

export type LLMProvider = 'openai' | 'azure-openai' | 'anthropic' | 'gemini';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  // Azure OpenAI specific fields
  azureOpenAIEndpoint?: string;
  azureOpenAIApiVersion?: string;
  azureOpenAIDeploymentName?: string;
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
    maxRetries: 3,
    azureOpenAIApiVersion: '2024-02-01' // Default Azure OpenAI API version
  };

  // Default models for each provider
  private static readonly DEFAULT_MODELS: Record<LLMProvider, string> = {
    openai: 'gpt-4o-mini',
    'azure-openai': 'gpt-4o-mini',
    anthropic: 'claude-3-haiku-20240307',
    gemini: 'gemini-2.5-flash'  // Use the latest 2.5 Flash model as default (2025)
  };

  constructor() {}

  /**
   * Initialize or get a chat model for the specified provider
   */
  public getChatModel(config: LLMConfig): any {
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
      case 'azure-openai':
        // Azure OpenAI keys are typically 32 characters long and don't have a specific prefix
        return apiKey.length >= 20; // More flexible validation for Azure keys
      case 'anthropic':
        return apiKey.startsWith('sk-ant-') && apiKey.length > 20;
      case 'gemini':
        return apiKey.length > 20; // Google API keys don't have a consistent prefix
      default:
        return false;
    }
  }

  /**
   * Validate Azure OpenAI configuration
   */
  public validateAzureOpenAIConfig(config: LLMConfig): { valid: boolean; error?: string } {
    if (config.provider !== 'azure-openai') {
      return { valid: false, error: 'Provider must be azure-openai' };
    }

    if (!config.azureOpenAIEndpoint) {
      return { valid: false, error: 'Azure OpenAI endpoint is required' };
    }

    if (!config.azureOpenAIEndpoint.includes('openai.azure.com')) {
      return { valid: false, error: 'Invalid Azure OpenAI endpoint format. Should contain "openai.azure.com"' };
    }

    if (!config.azureOpenAIDeploymentName) {
      return { valid: false, error: 'Azure OpenAI deployment name is required' };
    }

    return { valid: true };
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
      case 'azure-openai':
        return [
          'gpt-4o',
          'gpt-4o-mini', 
          'gpt-4.1-mini-v2', // Common deployment name
          'gpt-4-turbo',
          'gpt-4',
          'gpt-35-turbo', // Note: Azure uses gpt-35-turbo instead of gpt-3.5-turbo
          'gpt-4-32k'
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
          'gemini-2.5-flash',         // Latest and fastest (2025) - NEW DEFAULT
          'gemini-2.5-pro',           // Latest pro model (2025) - PREMIUM
          'gemini-1.5-flash',         // Most stable and widely available
          'gemini-1.5-pro',           // Stable pro model
          'gemini-1.0-pro',           // Legacy but very stable
          'gemini-1.5-flash-8b',      // Smaller, efficient version
          'gemini-2.0-flash',         // Newer model (may not be available to all users)
          'gemini-2.0-flash-lite'     // Lightweight version
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
      case 'azure-openai':
        return 'Azure OpenAI';
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
      // Validate Azure OpenAI config if needed
      if (config.provider === 'azure-openai') {
        const validation = this.validateAzureOpenAIConfig(config);
        if (!validation.valid) {
          return {
            success: false,
            error: validation.error
          };
        }
      }

      const model = this.createChatModel(config);
      
      // Send a simple test message
      const testMessages = [
        new HumanMessage("Test connection")
      ];
      
      await model.invoke(testMessages);
      return { success: true };
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
  private createChatModel(config: LLMConfig): any {
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

      case 'azure-openai':
        return new AzureChatOpenAI({
          azureOpenAIApiKey: config.apiKey,
          model: config.azureOpenAIDeploymentName, // Use deployment name as model
          temperature: mergedConfig.temperature,
          maxTokens: mergedConfig.maxTokens,
          maxRetries: mergedConfig.maxRetries,
          timeout: 30000,
          azureOpenAIApiInstanceName: config.azureOpenAIEndpoint?.replace('https://', '').split('.')[0],
          azureOpenAIApiVersion: config.azureOpenAIApiVersion,
          azureOpenAIApiDeploymentName: config.azureOpenAIDeploymentName
        });

      case 'anthropic':
        return new ChatAnthropic({
          model: config.model || 'claude-3-sonnet-20240229',
          anthropicApiKey: config.apiKey,
          maxTokens: config.maxTokens || 4096,
          temperature: config.temperature || 0.7
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
    let baseKey = `${config.provider}:${model}:${config.apiKey.slice(-8)}:${config.temperature}:${config.maxTokens}`;
    
    // Add Azure OpenAI specific fields to cache key
    if (config.provider === 'azure-openai') {
      baseKey += `:${config.azureOpenAIEndpoint}:${config.azureOpenAIDeploymentName}:${config.azureOpenAIApiVersion}`;
    }
    
    return baseKey;
  }
} 
