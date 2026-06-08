import { describe, it, expect } from 'vitest';
import { parseCobertura } from '../../src/core/coverage/parsers/cobertura.js';

const SAMPLE_COBERTURA = `<?xml version="1.0" ?>
<coverage version="1.0" timestamp="1234567890" lines-valid="10" lines-covered="7" branches-valid="4" branches-covered="3" complexity="0">
  <packages>
    <package name="src" line-rate="0.7" branch-rate="0.75" complexity="0">
      <classes>
        <class name="Main" filename="src/main.ts" line-rate="0.8" branch-rate="0.5" complexity="0">
          <methods>
            <method name="run" signature="()V" line-rate="1.0" branch-rate="1.0" complexity="0">
              <lines>
                <line number="10" hits="5" branch="false"/>
                <line number="11" hits="3" branch="true" condition-coverage="100% (2/2)"/>
              </lines>
            </method>
          </methods>
          <lines>
            <line number="1" hits="2"/>
            <line number="5" hits="0"/>
          </lines>
        </class>
        <class name="Util" filename="src/util.ts" line-rate="0.5" branch-rate="0.5" complexity="0">
          <lines>
            <line number="20" hits="4"/>
            <line number="21" hits="0" branch="true" condition-coverage="50% (1/2)"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

describe('parseCobertura', () => {
  it('parses a basic Cobertura XML file', () => {
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    expect(result.format).toBe('gitnexus-coverage-v1');
    expect(result.run.id).toBe('run-1');
    expect(result.files).toBeDefined();
    expect(Object.keys(result.files)).toHaveLength(2);
  });

  it('extracts line hits correctly', () => {
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    // src/main.ts
    const mainCov = result.files['src/main.ts'];
    expect(mainCov).toBeDefined();
    expect(mainCov.lines['1']).toBe(2);
    expect(mainCov.lines['5']).toBe(0);
    expect(mainCov.lines['10']).toBe(5);
    expect(mainCov.lines['11']).toBe(3);
  });

  it('extracts branch coverage from condition-coverage', () => {
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    // src/util.ts has branch on line 21
    const utilCov = result.files['src/util.ts'];
    expect(utilCov).toBeDefined();
    expect(utilCov.branches).toBeDefined();
    // 1 of 2 branches covered
    expect(utilCov.branches!['21:0']).toBe(1);
    expect(utilCov.branches!['21:1']).toBe(0);
  });

  it('extracts full branch coverage from condition-coverage', () => {
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    // src/main.ts line 11 has 100% (2/2) branch coverage
    const mainCov = result.files['src/main.ts'];
    expect(mainCov.branches).toBeDefined();
    expect(mainCov.branches!['11:0']).toBe(2);
  });

  it('counts total and covered lines', () => {
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    // 6 lines total across both files (1,5,10,11 in main.ts + 20,21 in util.ts)
    expect(result.run.totalLines).toBe(6);
    // 4 covered: 1(2), 10(5), 11(3), 20(4); 2 uncovered: 5(0), 21(0)
    expect(result.run.coveredLines).toBe(4);
  });

  it('handles empty coverage XML', () => {
    const emptyXml = '<?xml version="1.0" ?><coverage></coverage>';
    const meta = { id: 'run-1', timestamp: new Date().toISOString() };
    const result = parseCobertura(emptyXml, meta);

    expect(result.format).toBe('gitnexus-coverage-v1');
    expect(Object.keys(result.files)).toHaveLength(0);
    expect(result.run.totalLines).toBe(0);
    expect(result.run.coveredLines).toBe(0);
  });

  it('passes through meta fields', () => {
    const meta = {
      id: 'run-42',
      timestamp: '2026-06-08T00:00:00Z',
      label: 'cobertura-test',
      command: 'pytest --cov',
    };
    const result = parseCobertura(SAMPLE_COBERTURA, meta);

    expect(result.run.id).toBe('run-42');
    expect(result.run.timestamp).toBe('2026-06-08T00:00:00Z');
    expect(result.run.label).toBe('cobertura-test');
    expect(result.run.command).toBe('pytest --cov');
  });
});
