import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('debug3', () => {
  it('plain node with no env', () => {
    // Try with completely clean env
    try {
      const out = execSync('env | grep -i node_opt || echo NONE', {
        encoding: 'utf8',
        timeout: 5000,
      });
      console.log('Default env NODE_OPTIONS:', out.trim());
    } catch (e: any) {
      console.log('err:', e.stderr);
    }
    
    try {
      const out = execSync('node -e "console.log(42)"', {
        encoding: 'utf8',
        timeout: 5000,
      });
      console.log('Simple node output:', out.trim());
    } catch (e: any) {
      console.log('Simple node err:', e.stderr);
    }
  });
});
