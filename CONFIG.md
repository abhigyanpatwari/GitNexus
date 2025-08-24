# GitNexus Configuration

## Feature Flags

GitNexus uses feature flags to control the visibility of experimental and advanced features. By default, the UI is kept clean and simple for end users.

### Available Feature Flags

- `showEngineSelector` - Show engine selection dropdown
- `showEnginePerformanceInfo` - Display performance comparison data
- `showEngineCapabilities` - Show engine capabilities grid
- `enableNextGenEngine` - Enable next-generation processing engine
- `enableEngineComparison` - Run performance comparisons between engines
- `enableDebugMode` - Show debugging information
- `showProcessingDetails` - Display detailed processing information

### Enabling Features for Development

To enable advanced features during development, modify `/src/config/feature-flags.ts`:

```typescript
export const getFeatureFlags = (): FeatureFlags => {
  if (import.meta.env.DEV) {
    return {
      ...defaultFeatureFlags,
      // Enable engine features for development
      showEngineSelector: true,
      showEnginePerformanceInfo: true,
      showEngineCapabilities: true,
      enableDebugMode: true,
      showProcessingDetails: true,
    };
  }
  
  return defaultFeatureFlags;
};
```

### Production Configuration

For production builds, keep feature flags disabled to maintain a clean user interface:

```typescript
export const defaultFeatureFlags: FeatureFlags = {
  showEngineSelector: false,        // Hidden from end users
  showEnginePerformanceInfo: false, // Hidden from end users
  showEngineCapabilities: false,    // Hidden from end users
  enableNextGenEngine: true,        // Enabled behind the scenes
  enableEngineComparison: false,    // Disabled to save resources
  enableDebugMode: false,
  showProcessingDetails: false,
};
```

### Environment Variables

You can also control features via environment variables:

```bash
# Enable engine selector in development
VITE_SHOW_ENGINE_SELECTOR=true npm run dev

# Enable all debug features
VITE_DEBUG_MODE=true npm run dev
```

## Layout Configuration

The new layout prioritizes the graph visualization:

- **Left Sidebar (400px)**: Processing status, chat interface, and actions
- **Right Side (flex)**: Full graph visualization
- **Mobile**: Responsive single-column layout

This provides maximum space for the graph while keeping the chat interface easily accessible.