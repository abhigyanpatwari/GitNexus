/**
 * ControlFlowContext (issue #2081 M1; finalizer frames added by #2082 M2 U2).
 *
 * Resolves the targets of `break`/`continue` (plain and labeled) as the visitor
 * descends through loops and switches. Loops and switches push a target frame
 * on entry and pop it on exit; a labeled statement attaches its label to the
 * frame of the construct it labels, so `break outer` / `continue outer` resolve
 * against the right enclosing loop/switch rather than the nearest one.
 *
 * M2 adds FINALIZER frames, interleaved on the SAME stack as loop/switch frames
 * — interleaving is load-bearing: a jump must route through exactly the
 * `finally` bodies lexically BETWEEN it and its target (target-relative
 * threading). A `break` whose loop lives entirely inside the `try` crosses no
 * finally and must keep its direct edge; re-routing it anyway would force the
 * only path to the in-try continuation through the finally, letting a finally
 * redefinition falsely KILL in-loop definitions for the downstream
 * reaching-defs pass (a taint false negative). A parallel stack cannot express
 * that between-ness, which is why the frames live here.
 */
import type { CfgBuilder } from './cfg-builder.js';
import type { CfgEdgeKind } from './types.js';

interface LoopFrame {
  readonly kind: 'loop';
  /** Block a `continue` jumps to (the loop header / update). */
  readonly continueTo: number;
  /** Block a `break` jumps to (the loop exit / join). */
  readonly breakTo: number;
  /** All labels naming this construct (`outer: inner: for` carries both). */
  readonly labels: readonly string[];
}

interface SwitchFrame {
  readonly kind: 'switch';
  /** Block a `break` jumps to (after the switch). `continue` is invalid here. */
  readonly breakTo: number;
  readonly labels: readonly string[];
}

/**
 * A labeled NON-loop statement (`blk: { … break blk; … }`) — break-to-label
 * targets the synthesized join after the body (tri-review P1: routing such a
 * break to EXIT removed the real continuation and falsely killed every def
 * live at the jump for post-construct uses). Matched ONLY by a labeled break
 * naming it; unlabeled breaks and continues skip it.
 */
interface BlockFrame {
  readonly kind: 'block';
  readonly breakTo: number;
  readonly labels: readonly string[];
}

/** A `finally` whose body any crossing jump must route through. */
export interface FinalizerFrame {
  readonly kind: 'finalizer';
  /** Entry block of the finally body. */
  readonly entry: number;
  /**
   * Completion legs registered by jumps that crossed this finally: once the
   * owning try pops the frame, it wires `finally-exits → to` with `kind` for
   * each entry. Mutated by the jump handlers via {@link ControlFlowContext}.
   */
  readonly pending: { to: number; kind: CfgEdgeKind }[];
}

type Frame = LoopFrame | SwitchFrame | BlockFrame | FinalizerFrame;
type TargetFrame = LoopFrame | SwitchFrame | BlockFrame;

/** A resolved jump: its ultimate target + the finallys it crosses (inner→outer). */
export interface JumpResolution {
  readonly target: number;
  readonly finalizers: readonly FinalizerFrame[];
}

export class ControlFlowContext {
  private readonly stack: Frame[] = [];

  pushLoop(continueTo: number, breakTo: number, labels: readonly string[] = []): void {
    this.stack.push({ kind: 'loop', continueTo, breakTo, labels });
  }

  pushSwitch(breakTo: number, labels: readonly string[] = []): void {
    this.stack.push({ kind: 'switch', breakTo, labels });
  }

  /** Push a labeled non-loop statement's break-target frame. */
  pushLabeledBlock(breakTo: number, labels: readonly string[]): void {
    this.stack.push({ kind: 'block', breakTo, labels });
  }

  /**
   * Push a finalizer frame and return it — the owning `visitTry` keeps the
   * reference to wire {@link FinalizerFrame.pending} after popping it.
   */
  pushFinalizer(entry: number): FinalizerFrame {
    const frame: FinalizerFrame = { kind: 'finalizer', entry, pending: [] };
    this.stack.push(frame);
    return frame;
  }

  pop(): void {
    this.stack.pop();
  }

  /**
   * Resolve a `break`: the nearest enclosing loop/switch frame (or, with a
   * label, the nearest frame carrying that label) plus every finalizer frame
   * stacked ABOVE it — i.e. exactly the finallys the jump crosses, innermost
   * first. Returns `undefined` if there is no valid target (malformed input or
   * an unmodeled label) — the caller falls back to its conservative routing and
   * threads nothing.
   */
  resolveBreak(label?: string): JumpResolution | undefined {
    return this.resolve((f) =>
      label === undefined
        ? f.kind !== 'block' // an unlabeled break never targets a labeled block
        : f.labels.includes(label),
    );
  }

  /** Resolve a `continue`: like {@link resolveBreak} but only loop frames match. */
  resolveContinue(label?: string): JumpResolution | undefined {
    return this.resolve(
      (f) => f.kind === 'loop' && (label === undefined || f.labels.includes(label)),
      (f) => (f as LoopFrame).continueTo,
    );
  }

  /**
   * Resolve a Java `yield e` (switch-EXPRESSION arm exit): the nearest enclosing
   * SWITCH frame's exit, threading the finalizers stacked above it. Unlike a
   * `break`, a `yield` ALWAYS targets the switch — never an intervening loop — so
   * it cannot match a loop frame (a `yield` inside a loop inside a switch arm
   * still exits the whole switch). Returns `undefined` when there is no enclosing
   * switch (malformed input); the caller falls back to its conservative routing.
   */
  resolveYield(): JumpResolution | undefined {
    return this.resolve((f) => f.kind === 'switch');
  }

  /** Every active finalizer, innermost first — what a `return` must cross. */
  finalizersForReturn(): readonly FinalizerFrame[] {
    const fins: FinalizerFrame[] = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f.kind === 'finalizer') fins.push(f);
    }
    return fins;
  }

  /**
   * Target block for a `break` (no finalizer info) — see {@link resolveBreak}.
   * Prefer `resolveBreak` + {@link wireJumpThroughFinalizers} in visitors: a
   * target-only lookup silently loses finalizer threading (the M2 soundness
   * fix). Kept for target-shape assertions in tests.
   */
  breakTarget(label?: string): number | undefined {
    return this.resolveBreak(label)?.target;
  }

  /** Target block for a `continue` — same caveat as {@link breakTarget}. */
  continueTarget(label?: string): number | undefined {
    return this.resolveContinue(label)?.target;
  }

  private resolve(
    matches: (f: TargetFrame) => boolean,
    targetOf: (f: TargetFrame) => number = (f) => f.breakTo,
  ): JumpResolution | undefined {
    const crossed: FinalizerFrame[] = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f.kind === 'finalizer') {
        crossed.push(f);
        continue;
      }
      if (matches(f)) return { target: targetOf(f), finalizers: crossed };
    }
    return undefined;
  }
}

/**
 * Wire a jump from `from` to `target`, routing through the finallys it
 * crosses (innermost first). The first leg keeps the bare jump `kind`
 * (preserving the "kind ⟹ source-block terminator" invariant in types.ts);
 * each finally's completion leg is registered as pending on its frame with the
 * matching `finally-*` kind and wired by the owning try via
 * {@link drainFinalizerPending} once the finally's exits are known.
 *
 * Language-agnostic on purpose (#2082 M2): the threading protocol encodes
 * three subtle invariants every future language visitor needs identically —
 * keeping it here means a new visitor cannot drift on any of them.
 */
export function wireJumpThroughFinalizers(
  builder: CfgBuilder,
  from: number,
  finalizers: readonly FinalizerFrame[],
  target: number,
  kind: 'return' | 'break' | 'continue',
): void {
  if (finalizers.length === 0) {
    builder.edge(from, target, kind);
    return;
  }
  const completionKind = `finally-${kind}` as CfgEdgeKind;
  builder.edge(from, finalizers[0].entry, kind);
  for (let i = 0; i < finalizers.length; i++) {
    const to = i + 1 < finalizers.length ? finalizers[i + 1].entry : target;
    finalizers[i].pending.push({ to, kind: completionKind });
  }
}

/**
 * Wire a popped finalizer frame's pending completion legs from the finally's
 * exit blocks. A finally that itself always jumps (`finally { return 2; }`)
 * has no exits — its pending legs wire nowhere, matching JS's
 * finally-override semantics.
 */
export function drainFinalizerPending(
  builder: CfgBuilder,
  frame: FinalizerFrame,
  finallyExits: readonly number[],
): void {
  for (const p of frame.pending) {
    builder.connect(finallyExits, p.to, p.kind);
  }
}
