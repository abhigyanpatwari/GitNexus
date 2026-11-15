import { describe, expect, it } from 'vitest';
import { cobolProvider } from '../../../src/core/ingestion/languages/cobol.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { block, reaches, bindingIdx } from '../../helpers/cfg-harness.js';

const source = (body: string, data = '01 X PIC 9.\n01 Y PIC 9.\n01 FLAG PIC 9.') =>
  `       >>SOURCE FORMAT FREE\nidentification division.\nprogram-id. Demo.\ndata division.\nworking-storage section.\n${data}\nprocedure division.\n${body}\nend program Demo.`;

function collect(text: string, cap = 0) {
  expect(cobolProvider.collectSourceCfgs).toBeTypeOf('function');
  return cobolProvider.collectSourceCfgs!(text, 'demo.cbl', cap);
}

function cfgOf(body: string, data?: string): FunctionCfg {
  const result = collect(source(body, data));
  expect(result.skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 });
  expect(result.cfgs).toHaveLength(1);
  return result.cfgs[0]!;
}

const hasEdge = (cfg: FunctionCfg, from: number, to: number, kind?: string) =>
  cfg.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));

describe('COBOL source CFG provider', () => {
  it('does not confuse a group with a different group whose name has the same suffix', () => {
    const cfg = cfgOf(
      'move 1 to REC\ndisplay AMOUNT OF OTHER-REC\ngoback.',
      '01 REC.\n05 AMOUNT PIC 9.\n01 OTHER-REC.\n05 AMOUNT PIC 9.',
    );
    const written = cfg.blocks[block(cfg, 'move 1')]!.statements![0]!.defs;
    expect(written).toContain(bindingIdx(cfg, 'AMOUNT OF REC'));
    expect(written).not.toContain(bindingIdx(cfg, 'AMOUNT OF OTHER-REC'));
  });

  it('keeps decimal constants inside their statement', () => {
    const cfg = cfgOf('move 1.5 to x\ndisplay x\ngoback.');
    expect(cfg.blocks[block(cfg, 'move 1.5')]!.statements![0]!.defs).toContain(
      bindingIdx(cfg, 'X'),
    );
  });

  it('zero TIMES does not enter an inline or out-of-line body', () => {
    const cfg = cfgOf(
      'perform 0 times\nmove 8 to x\nend-perform\nperform worker 0 times\ndisplay x\ngoback.\nworker.\nmove 9 to x.',
    );
    expect(cfg.blocks.some((b) => /move [89]/.test(b.text))).toBe(false);
  });

  it('PERFORM nests a second range and EXIT SECTION returns to the active continuation', () => {
    const cfg = cfgOf(
      'perform workers\ndisplay y\ngoback.\nworkers section.\nfirst-worker.\nperform helper\nexit section\nmove 8 to y.\nlast-worker.\nmove 9 to y.\nhelpers section.\nhelper.\nmove 1 to y.',
    );
    expect(reaches(cfg, block(cfg, 'move 1'), block(cfg, 'display y'))).toBe(true);
    expect(cfg.blocks.some((b) => /move [89]/.test(b.text))).toBe(false);
  });

  it('rejects split-word/literal continuation instead of fabricating token identities', () => {
    const text = [
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. FIXED.',
      '000300 PROCEDURE DIVISION.',
      '000400     MOVE WS-',
      '000500-    VALUE TO RESULT',
      '000600     STOP RUN.',
    ].join('\n');
    expect(collect(text).skipped.buildError).toBe(1);
  });

  it('uses the standard depth budget for pathological nested conditions', () => {
    const body = 'if flag = 1\n'.repeat(260) + 'display x\n' + 'end-if\n'.repeat(260) + 'goback.';
    expect(collect(source(body)).skipped.tooDeeplyNested).toBe(1);
  });

  it('rejects REDEFINES aliases instead of claiming disjoint storage', () => {
    const result = collect(
      source('move 1 to x\ndisplay y\ngoback.', '01 X PIC 9.\n01 Y REDEFINES X PIC 9.'),
    );
    expect(result.skipped.buildError).toBe(1);
  });

  it('owns the procedure region with the existing program Module ID', () => {
    const cfg = cfgOf('main.\nmove 1 to x\nnext-para.\ndisplay x\ngoback.');
    expect(cfg.ownerId).toBe('Module:demo.cbl:Demo');
    expect(cfg.functionStartLine).toBe(9);
    expect(reaches(cfg, block(cfg, 'move 1 to x'), block(cfg, 'display x'))).toBe(true);
    expect(
      computeReachingDefs(cfg).facts.some(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'X') &&
          f.def.blockIndex === block(cfg, 'move 1 to x') &&
          f.use.blockIndex === block(cfg, 'display x'),
      ),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
  });

  it('branches IF and EVALUATE through the generic CDG and reaching-def solver', () => {
    const cfg = cfgOf(`if flag = 1
  move 1 to x
else
  move 2 to x
end-if
evaluate x
  when 1 move x to y
  when other move 0 to y
end-evaluate
display y
stop run.`);
    const cond = block(cfg, 'if flag');
    expect(hasEdge(cfg, cond, block(cfg, 'move 1'), 'cond-true')).toBe(true);
    expect(hasEdge(cfg, cond, block(cfg, 'move 2'), 'cond-false')).toBe(true);
    expect(computeControlDependence(cfg).edges).toContainEqual({
      controllerBlock: cond,
      dependentBlock: block(cfg, 'move 1'),
      label: 'T',
    });
    const rd = computeReachingDefs(cfg);
    expect(rd.status).toBe('computed');
    expect(
      rd.facts.filter(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'Y') && f.use.blockIndex === block(cfg, 'display y'),
      ),
    ).toHaveLength(2);
  });

  it('a sentence period terminates nested IF scopes', () => {
    const cfg = cfgOf('if flag = 1\n if x = 1\n move 2 to y.\ndisplay y\ngoback.');
    expect(reaches(cfg, block(cfg, 'if flag'), block(cfg, 'display y'))).toBe(true);
    expect(
      computeControlDependence(cfg).edges.some((e) => e.dependentBlock === block(cfg, 'display y')),
    ).toBe(false);
  });

  it('returns PERFORM THRU only after the last paragraph, with no caller bypass', () => {
    const cfg = cfgOf(`main.
perform first-para thru last-para
display y
goback.
first-para.
move 1 to x.
middle-para.
move x to y.
last-para.
exit.
unrelated.
move 9 to y.`);
    const call = block(cfg, 'perform first-para');
    const read = block(cfg, 'display y');
    expect(hasEdge(cfg, call, read)).toBe(false);
    expect(reaches(cfg, call, block(cfg, 'move x to y'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'move x to y'), read)).toBe(true);
    expect(cfg.blocks.some((b) => b.text.includes('move 9'))).toBe(false);
    expect(
      computeReachingDefs(cfg).facts.some(
        (f) =>
          f.bindingIdx === bindingIdx(cfg, 'Y') &&
          f.def.blockIndex === block(cfg, 'move x to y') &&
          f.use.blockIndex === read,
      ),
    ).toBe(true);
  });

  it('keeps two PERFORM return continuations separate', () => {
    const cfg = cfgOf(
      'perform worker\nmove x to y\nperform worker\ndisplay x\ngoback.\nworker.\nadd 1 to x.',
    );
    const workers = cfg.blocks.filter((b) => b.text.includes('add 1 to x'));
    expect(workers).toHaveLength(2);
    const middle = block(cfg, 'move x to y');
    const last = block(cfg, 'display x');
    const returning = workers.map((w) =>
      cfg.edges.filter((e) => e.from === w.index).map((e) => e.to),
    );
    expect(returning[0]).not.toEqual(returning[1]);
    expect(reaches(cfg, middle, last)).toBe(true);
  });

  it('GO TO skips following statements and EXIT PARAGRAPH jumps to the paragraph boundary', () => {
    const cfg = cfgOf(
      'go to target\nmove 9 to x.\ntarget.\nmove 1 to x\nexit paragraph\nmove 8 to x.\nnext-one.\ndisplay x\nstop run.',
    );
    expect(cfg.blocks.some((b) => /move [89]/.test(b.text))).toBe(false);
    expect(reaches(cfg, block(cfg, 'move 1'), block(cfg, 'display x'))).toBe(true);
  });

  it('PERFORM section returns after its final paragraph', () => {
    const cfg = cfgOf(
      'perform workers\ndisplay y\ngoback.\nworkers section.\na.\nmove 1 to x.\nb.\nmove x to y.\nother section.\nz.\nmove 9 to y.',
    );
    expect(reaches(cfg, block(cfg, 'move x'), block(cfg, 'display y'))).toBe(true);
    expect(cfg.blocks.some((b) => b.text.includes('move 9'))).toBe(false);
  });

  it('models inline UNTIL/VARYING, loop updates, EXIT PERFORM and CYCLE', () => {
    const cfg = cfgOf(`perform varying x from 1 by 1 until x > 5
  if flag = 1 exit perform end-if
  if flag = 2 exit perform cycle end-if
  add x to y
end-perform
display y
goback.`);
    expect(cfg.edges.some((e) => e.kind === 'loop-back')).toBe(true);
    const exit = block(cfg, 'exit perform');
    expect(reaches(cfg, exit, block(cfg, 'display y'))).toBe(true);
    const x = bindingIdx(cfg, 'X');
    expect(
      cfg.blocks.some((b) => b.statements?.some((s) => s.defs.includes(x) && s.uses.includes(x))),
    ).toBe(true);
  });

  it('TEST AFTER executes its body before the UNTIL test', () => {
    const cfg = cfgOf(
      'perform with test after until flag = 1\nmove 1 to x\nend-perform\ndisplay x\ngoback.',
    );
    const first = cfg.edges.find((e) => e.from === cfg.entryIndex)!;
    expect(cfg.blocks[first.to]!.text).toContain('move 1');
  });

  it('resolves qualified data names case-insensitively and preserves independent fields', () => {
    const cfg = cfgOf(
      'move 1 to value of left-rec\nmove 2 to VALUE IN right-rec\ndisplay VaLuE of LEFT-REC\ngoback.',
      '01 LEFT-REC.\n05 VALUE PIC 9.\n01 RIGHT-REC.\n05 VALUE PIC 9.',
    );
    const rd = computeReachingDefs(cfg);
    const read = block(cfg, 'display');
    expect(
      rd.facts.filter((f) => f.use.blockIndex === read).map((f) => rd.bindings[f.bindingIdx]!.name),
    ).toEqual(['VALUE OF LEFT-REC']);
  });

  it('array element writes are may-defs and read their subscripts', () => {
    const cfg = cfgOf('move 1 to x(flag)\ndisplay x(y)\ngoback.');
    const facts = cfg.blocks[block(cfg, 'move 1')]!.statements![0]!;
    expect(facts.mayDefs).toContain(bindingIdx(cfg, 'X'));
    expect(facts.defs).not.toContain(bindingIdx(cfg, 'X'));
    expect(facts.uses).toContain(bindingIdx(cfg, 'FLAG'));
  });

  it('CALL records positional uses, reference may-defs and RETURNING defs', () => {
    const cfg = cfgOf(
      'call "OTHER" using by reference x by content y returning flag\ndisplay flag\ngoback.',
    );
    const f = cfg.blocks[block(cfg, 'call')]!.statements![0]!;
    expect(f.sites?.[0]).toMatchObject({
      kind: 'call',
      callee: 'OTHER',
      args: [[bindingIdx(cfg, 'X')], [bindingIdx(cfg, 'Y')]],
      resultDefs: [bindingIdx(cfg, 'FLAG')],
    });
    expect(f.mayDefs).toEqual([bindingIdx(cfg, 'X')]);
    expect(f.defs).toEqual([bindingIdx(cfg, 'FLAG')]);
  });

  it('preserves fixed-format source lines and columns while excluding comments', () => {
    const text = [
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. FIXED.',
      '000300 DATA DIVISION.',
      '000400 WORKING-STORAGE SECTION.',
      '000500 01 X PIC 9.',
      '000600 PROCEDURE DIVISION.',
      '000700*    ALTER A TO PROCEED TO B.',
      '000800     MOVE 1 TO X',
      '000900     DISPLAY X',
      '001000     STOP RUN.',
    ].join('\n');
    const cfg = collect(text).cfgs[0]!;
    expect(cfg).toBeDefined();
    expect(cfg.blocks[block(cfg, 'MOVE 1')]!.startLine).toBe(8);
    expect(cfg.bindings?.find((b) => b.name === 'X')).toMatchObject({
      declLine: 5,
      declColumn: 10,
    });
  });

  it.each([
    'alter a to proceed to b.',
    'exec sql select X end-exec.',
    'go to a b depending on x.',
    'perform missing.',
    'search x when y = 1 continue end-search.',
  ])('reports unsupported control as a visible build gap: %s', (body) => {
    const result = collect(source(body));
    expect(result.cfgs).toEqual([]);
    expect(result.skipped.buildError).toBe(1);
  });

  it.each([
    'ADD CORRESPONDING SRC TO DST',
    'ADD CORR SRC TO DST',
    'SUBTRACT CORRESPONDING SRC FROM DST',
    'SUBTRACT CORR SRC FROM DST',
  ])(
    'reports unsupported corresponding arithmetic without overwriting unmatched children: %s',
    (statement) => {
      const result = collect(
        source(
          `MOVE 1 TO BB OF DST\n${statement}\nDISPLAY BB OF DST\nGOBACK.`,
          '01 SRC.\n05 AA PIC 9.\n01 DST.\n05 AA PIC 9.\n05 BB PIC 9.',
        ),
      );
      expect(result.cfgs).toEqual([]);
      expect(result.skipped).toEqual({ tooManyLines: 0, tooDeeplyNested: 0, buildError: 1 });
    },
  );

  it('bounds procedure-region lines and recursive PERFORM expansion', () => {
    expect(collect(source('move 1 to x\ngoback.'), 1).skipped.tooManyLines).toBe(1);
    expect(
      collect(source('perform again\ngoback.\nagain.\nperform again.')).skipped.buildError,
    ).toBe(1);
  });

  it('separates nested programs and continues after an unsupported sibling', () => {
    const text =
      source('goback.').replace(
        'end program Demo.',
        'identification division.\nprogram-id. Child.\nprocedure division.\nstop run.\nend program Child.\nend program Demo.',
      ) +
      '\nidentification division.\nprogram-id. Bad.\nprocedure division.\nalter x to proceed to y.\nend program Bad.';
    const result = collect(text);
    expect(result.cfgs.map((cfg) => cfg.ownerId)).toEqual([
      'Module:demo.cbl:Demo',
      'Module:demo.cbl:Child',
    ]);
    expect(result.skipped.buildError).toBe(1);
  });
});
