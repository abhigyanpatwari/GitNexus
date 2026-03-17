# Embedding API Configuration

GitNexus now supports using external OpenAI-compatible embedding APIs instead of local embeddings.

## Configuration

To use an API for embeddings, configure the following options in your `EmbeddingConfig`:

```typescript
{
  useApi: true,                           // Enable API mode
  apiEndpoint: 'https://api.example.com/v1/embeddings',  // OpenAI-compatible endpoint
  apiKey: 'your-api-key-here',           // API authentication key
  modelId: 'text-embedding-3-small',     // Model name for the API
  dimensions: 1536,                       // Embedding dimensions (match your API model)
  batchSize: 16,                          // Batch size for API requests
}
```

## OpenAI-Compatible Format

The API must follow the OpenAI embeddings convention:

### Request Format
```json
POST /v1/embeddings
{
  "input": ["text1", "text2", ...],
  "model": "text-embedding-3-small"
}
```

### Response Format
```json
{
  "data": [
    {
      "embedding": [0.1, 0.2, 0.3, ...]
    },
    ...
  ]
}
```

## Supported Providers

Any API that follows the OpenAI embeddings format will work:

- **OpenAI**: `https://api.openai.com/v1/embeddings`
- **Azure OpenAI**: `https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version=2023-05-15`
- **Local LLM servers** (Ollama, LM Studio, etc.) with OpenAI-compatible endpoints
- **Other providers** (Cohere, Voyage AI, etc.) with OpenAI-compatible wrappers

## Example Usage

### Using OpenAI API

```typescript
import { runEmbeddingPipeline } from './embedding-pipeline.js';

await runEmbeddingPipeline(
  executeQuery,
  executeWithReusedStatement,
  onProgress,
  {
    useApi: true,
    apiEndpoint: 'https://api.openai.com/v1/embeddings',
    apiKey: process.env.OPENAI_API_KEY,
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    batchSize: 100,  // OpenAI supports larger batches
  }
);
```

### Using Local API (Ollama)

```typescript
await runEmbeddingPipeline(
  executeQuery,
  executeWithReusedStatement,
  onProgress,
  {
    useApi: true,
    apiEndpoint: 'http://localhost:11434/v1/embeddings',
    apiKey: 'dummy',  // Ollama doesn't require auth
    modelId: 'nomic-embed-text',
    dimensions: 768,
    batchSize: 16,
  }
);
```

## Security Best Practices

1. **Never hardcode API keys** - Use environment variables
2. **Validate dimensions** - Ensure `dimensions` matches your API model
3. **Handle rate limits** - Adjust `batchSize` based on API limits
4. **Use HTTPS** - Always use secure endpoints in production

## Switching Between Local and API

The system automatically routes based on the `useApi` flag:

- `useApi: false` (default) - Uses local transformers.js embeddings
- `useApi: true` - Uses external API

You can switch between modes without code changes, just update the configuration.

## Error Handling

The API embedder will throw errors for:

- Missing `apiEndpoint` or `apiKey` when `useApi: true`
- Invalid API responses
- Network failures
- Dimension mismatches (warning only)

All errors are logged in development mode for debugging.
