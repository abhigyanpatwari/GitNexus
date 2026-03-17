/**
 * API Embedder Module
 * 
 * Handles embeddings via OpenAI-compatible API endpoints.
 * Supports any API that follows the OpenAI embeddings convention.
 */

import type { EmbeddingConfig } from './types.js';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Call OpenAI-compatible embedding API
 * 
 * @param texts - Array of texts to embed
 * @param config - Embedding configuration with API settings
 * @returns Array of Float32Array embedding vectors
 */
export const embedBatchViaAPI = async (
  texts: string[],
  config: EmbeddingConfig
): Promise<Float32Array[]> => {
  if (!config.apiEndpoint) {
    throw new Error('API endpoint is required when useApi is true');
  }
  
  if (!config.apiKey) {
    throw new Error('API key is required when useApi is true');
  }

  if (texts.length === 0) {
    return [];
  }

  try {
    const response = await fetch(config.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: config.modelId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // OpenAI format: { data: [{ embedding: number[] }, ...] }
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid API response format: missing data array');
    }

    // Convert to Float32Array format
    const embeddings: Float32Array[] = data.data.map((item: any, index: number) => {
      if (!item.embedding || !Array.isArray(item.embedding)) {
        throw new Error(`Invalid embedding format at index ${index}`);
      }
      return new Float32Array(item.embedding);
    });

    // Validate dimensions match config
    if (embeddings.length > 0 && embeddings[0].length !== config.dimensions) {
      if (isDev) {
        console.warn(
          `⚠️  API returned ${embeddings[0].length} dimensions, expected ${config.dimensions}. ` +
          `Update your config.dimensions to match the API model.`
        );
      }
    }

    return embeddings;
  } catch (error) {
    if (isDev) {
      console.error('❌ API embedding error:', error);
    }
    throw error;
  }
};

/**
 * Embed a single text via API
 * 
 * @param text - Text to embed
 * @param config - Embedding configuration with API settings
 * @returns Float32Array embedding vector
 */
export const embedTextViaAPI = async (
  text: string,
  config: EmbeddingConfig
): Promise<Float32Array> => {
  const embeddings = await embedBatchViaAPI([text], config);
  return embeddings[0];
};
