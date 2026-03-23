import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Reset localStorage between tests
beforeEach(() => {
  // jsdom's localStorage.clear() can be unreliable across vitest test boundaries
  // Explicitly remove the known key used by settings-service
  localStorage.removeItem('gitnexus-llm-settings');
});
