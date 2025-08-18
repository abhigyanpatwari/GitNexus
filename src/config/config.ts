/**
 * Centralized Configuration System
 * Provides type-safe configuration with environment validation and defaults
 */

import { z } from 'zod';

// Configuration schemas with validation
const MemoryConfigSchema = z.object({
  maxMemoryMB: z.number().min(100).max(2048).default(512),
  cleanupThresholdMB: z.number().min(50).max(1024).default(400),
  gcIntervalMs: z.number().min(5000).max(60000).default(30000),
  maxFileSizeMB: z.number().min(1).max(50).default(10),
  maxFilesInMemory: z.number().min(100).max(10000).default(1000)
});

const GitHubConfigSchema = z.object({
  apiUrl: z.string().url().default('https://api.github.com'),
  token: z.string().optional(),
  rateLimit: z.object({
    maxRequests: z.number().min(1).max(5000).default(60),
    windowMs: z.number().min(1000).max(3600000).default(60000)
  }),
  retry: z.object({
    maxRetries: z.number().min(0).max(5).default(3),
    backoffMs: z.number().min(100).max(10000).default(1000)
  })
});

const LLMConfigSchema = z.object({
  providers: z.object({
    openai: z.object({
      apiKey: z.string().optional(),
      model: z.string().default('gpt-4'),
      maxTokens: z.number().min(100).max(10000).default(2000),
      temperature: z.number().min(0).max(2).default(0.7)
    }).optional(),
    azure: z.object({
      apiKey: z.string().optional(),
      endpoint: z.string().url().optional(),
      deployment: z.string().optional(),
      maxTokens: z.number().min(100).max(10000).default(2000),
      temperature: z.number().min(0).max(2).default(0.7)
    }).optional(),
    anthropic: z.object({
      apiKey: z.string().optional(),
      model: z.string().default('claude-3-sonnet-20240229'),
      maxTokens: z.number().min(100).max(10000).default(2000),
      temperature: z.number().min(0).max(2).default(0.7)
    }).optional(),
    gemini: z.object({
      apiKey: z.string().optional(),
      model: z.string().default('gemini-pro'),
      maxTokens: z.number().min(100).max(10000).default(2000),
      temperature: z.number().min(0).max(2).default(0.7)
    }).optional()
  }),
  defaultProvider: z.enum(['openai', 'azure', 'anthropic', 'gemini']).default('openai')
});

const ProcessingConfigSchema = z.object({
  batchSize: z.number().min(1).max(100).default(10),
  maxConcurrentRequests: z.number().min(1).max(50).default(5),
  timeoutMs: z.number().min(1000).max(300000).default(30000),
  retry: z.object({
    maxRetries: z.number().min(0).max(5).default(3),
    backoffMs: z.number().min(100).max(10000).default(1000)
  }),
  fileExtensions: z.array(z.string()).default([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.dart',
    '.json', '.yaml', '.yml', '.xml', '.toml', '.ini', '.cfg', '.properties'
  ])
});

const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  enableMetrics: z.boolean().default(true),
  enablePerformanceTracking: z.boolean().default(true),
  maxLogEntries: z.number().min(100).max(10000).default(1000),
  monitoringIntervalMs: z.number().min(5000).max(60000).default(30000)
});

// Main configuration schema
const AppConfigSchema = z.object({
  memory: MemoryConfigSchema,
  github: GitHubConfigSchema,
  llm: LLMConfigSchema,
  processing: ProcessingConfigSchema,
  logging: LoggingConfigSchema,
  environment: z.enum(['development', 'staging', 'production']).default('development')
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ProcessingConfig = z.infer<typeof ProcessingConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Configuration service with environment validation
 */
export class ConfigService {
  private static instance: ConfigService;
  private config: AppConfig;
  private validationErrors: string[] = [];

  private constructor() {
    this.config = this.loadConfiguration();
    this.validateEnvironment();
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * Load configuration from environment variables and defaults
   */
  private loadConfiguration(): AppConfig {
    try {
      const config: AppConfig = {
        memory: {
          maxMemoryMB: this.getEnvNumber('MEMORY_MAX_MB', 512),
          cleanupThresholdMB: this.getEnvNumber('MEMORY_CLEANUP_THRESHOLD_MB', 400),
          gcIntervalMs: this.getEnvNumber('MEMORY_GC_INTERVAL_MS', 30000),
          maxFileSizeMB: this.getEnvNumber('MEMORY_MAX_FILE_SIZE_MB', 10),
          maxFilesInMemory: this.getEnvNumber('MEMORY_MAX_FILES', 1000)
        },
        github: {
          apiUrl: this.getEnvString('GITHUB_API_URL', 'https://api.github.com') ?? 'https://api.github.com',
          token: this.getEnvString('GITHUB_TOKEN'),
          rateLimit: {
            maxRequests: this.getEnvNumber('GITHUB_RATE_LIMIT_MAX', 60),
            windowMs: this.getEnvNumber('GITHUB_RATE_LIMIT_WINDOW_MS', 60000)
          },
          retry: {
            maxRetries: this.getEnvNumber('GITHUB_RETRY_MAX', 3),
            backoffMs: this.getEnvNumber('GITHUB_RETRY_BACKOFF_MS', 1000)
          }
        },
        llm: {
          providers: {
            openai: this.getLLMProviderConfig('OPENAI'),
            azure: this.getLLMProviderConfig('AZURE'),
            anthropic: this.getLLMProviderConfig('ANTHROPIC'),
            gemini: this.getLLMProviderConfig('GEMINI')
          },
          defaultProvider: (this.getEnvString('LLM_DEFAULT_PROVIDER', 'openai') as 'openai' | 'azure' | 'anthropic' | 'gemini') ?? 'openai'
        },
        processing: {
          batchSize: this.getEnvNumber('PROCESSING_BATCH_SIZE', 10),
          maxConcurrentRequests: this.getEnvNumber('PROCESSING_MAX_CONCURRENT', 5),
          timeoutMs: this.getEnvNumber('PROCESSING_TIMEOUT_MS', 30000),
          retry: {
            maxRetries: this.getEnvNumber('PROCESSING_RETRY_MAX', 3),
            backoffMs: this.getEnvNumber('PROCESSING_RETRY_BACKOFF_MS', 1000)
          },
          fileExtensions: this.getEnvArray('PROCESSING_FILE_EXTENSIONS', [
            '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
            '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.dart',
            '.json', '.yaml', '.yml', '.xml', '.toml', '.ini', '.cfg', '.properties'
          ])
        },
        logging: {
          level: (this.getEnvString('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
          enableMetrics: this.getEnvBoolean('LOG_ENABLE_METRICS', true),
          enablePerformanceTracking: this.getEnvBoolean('LOG_ENABLE_PERFORMANCE', true),
          maxLogEntries: this.getEnvNumber('LOG_MAX_ENTRIES', 1000),
          monitoringIntervalMs: this.getEnvNumber('LOG_MONITORING_INTERVAL_MS', 30000)
        },
        environment: (this.getEnvString('NODE_ENV', 'development') as 'development' | 'staging' | 'production') ?? 'development'
      };

      // Validate with Zod
      const result = AppConfigSchema.safeParse(config);
      if (!result.success) {
        this.validationErrors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        console.warn('Configuration validation errors:', this.validationErrors);
      }

      return result.success ? result.data : AppConfigSchema.parse({
        memory: {},
        github: { rateLimit: {}, retry: {} },
        llm: { providers: {} },
        processing: { retry: {} },
        logging: {},
      });
    } catch (error) {
      console.error('Failed to load configuration:', error);
      return AppConfigSchema.parse({});
    }
  }

  private getLLMProviderConfig(prefix: string) {
    const apiKey = this.getEnvString(`${prefix}_API_KEY`);
    if (!apiKey) return undefined;

    return {
      apiKey,
      model: this.getEnvString(`${prefix}_MODEL`) ?? 'gpt-4',
      maxTokens: this.getEnvNumber(`${prefix}_MAX_TOKENS`, 2000),
      temperature: this.getEnvNumber(`${prefix}_TEMPERATURE`, 0.7)
    };
  }

  private getEnvString(key: string, defaultValue?: string): string | undefined {
    return typeof process !== 'undefined' ? process.env[key] : defaultValue;
  }

  private getEnvNumber(key: string, defaultValue: number): number {
    const value = this.getEnvString(key);
    return value ? parseInt(value, 10) || defaultValue : defaultValue;
  }

  private getEnvBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.getEnvString(key);
    return value ? value.toLowerCase() === 'true' : defaultValue;
  }

  private getEnvArray(key: string, defaultValue: string[]): string[] {
    const value = this.getEnvString(key);
    return value ? value.split(',').map(s => s.trim()) : defaultValue;
  }

  /**
   * Validate environment configuration
   */
  private validateEnvironment(): void {
    const warnings: string[] = [];

    // Check for required API keys
    if (!this.config.github.token) {
      warnings.push('GitHub token not provided - rate limits will be lower');
    }

    const hasAnyLLMProvider = Object.values(this.config.llm.providers)
      .some(provider => provider?.apiKey);
    
    if (!hasAnyLLMProvider) {
      warnings.push('No LLM provider API keys configured - AI features disabled');
    }

    // Check memory limits
    if (this.config.memory.maxMemoryMB < 256) {
      warnings.push('Memory limit is very low - may cause performance issues');
    }

    if (warnings.length > 0) {
      console.warn('Configuration warnings:', warnings);
    }
  }

  /**
   * Get configuration values
   */
  public getConfiguration(): AppConfig {
    return this.config;
  }

  public get memory(): MemoryConfig {
    return this.config.memory;
  }

  public get github(): GitHubConfig {
    return this.config.github;
  }

  public get llm(): LLMConfig {
    return this.config.llm;
  }

  public get processing(): ProcessingConfig {
    return this.config.processing;
  }

  public get logging(): LoggingConfig {
    return this.config.logging;
  }

  public get environment(): string {
    return this.config.environment;
  }

  public get isDevelopment(): boolean {
    return this.config.environment === 'development';
  }

  public get isProduction(): boolean {
    return this.config.environment === 'production';
  }

  /**
   * Get validation errors
   */
  public getValidationErrors(): string[] {
    return [...this.validationErrors];
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(updates: Partial<AppConfig>): void {
    try {
      const newConfig = { ...this.config, ...updates };
      const result = AppConfigSchema.safeParse(newConfig);
      if (result.success) {
        this.config = result.data;
      } else {
        throw new Error(`Invalid configuration: ${result.error.errors.map(e => e.message).join(', ')}`);
      }
    } catch (error) {
      console.error('Failed to update configuration:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const config = ConfigService.getInstance();