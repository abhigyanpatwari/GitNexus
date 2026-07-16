// This ambient shim intentionally shadows the optional package's bundled types
// in dependency-pruned CI. Mirror any newly used transformer API surface here.
declare module '@huggingface/transformers' {
  export interface ProgressInfo {
    status?: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
  }

  export interface FeatureExtractionResult {
    data: ArrayLike<number>;
  }

  export interface FeatureExtractionOptions {
    pooling?: string;
    normalize?: boolean;
  }

  export interface FeatureExtractionPipeline {
    (
      input: string | string[],
      options?: FeatureExtractionOptions,
    ): Promise<FeatureExtractionResult>;
    dispose?: () => void | Promise<void>;
  }

  export interface PipelineOptions {
    device?: string;
    dtype?: string;
    progress_callback?: (progress: ProgressInfo) => void;
    session_options?: Record<string, unknown>;
  }

  export function pipeline(
    task: 'feature-extraction',
    model: string,
    options?: PipelineOptions,
  ): Promise<FeatureExtractionPipeline>;

  export const env: {
    allowLocalModels: boolean;
    cacheDir: string;
    remoteHost: string;
  };
}
