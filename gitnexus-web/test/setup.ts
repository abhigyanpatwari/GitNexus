import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Reset storage between tests
beforeEach(() => {
  sessionStorage.removeItem('gitnexus-llm-settings');
  localStorage.removeItem('gitnexus-llm-settings'); // legacy key (migration)
});
