import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('env check', () => {
  it('shows NODE_OPTIONS', () => {
    console.log('NODE_OPTIONS in test:', JSON.stringify(process.env.NODE_OPTIONS));
    const cleanEnv = { ...process.env, NODE_OPTIONS: '' };
    const out = execSync('node -e "console.log(process.env.NODE_OPTIONS)"', {
      encoding: 'utf8',
      env: cleanEnv,
    });
    console.log('Child NODE_OPTIONS:', out.trim());
    expect(true).toBe(true);
  });
});
