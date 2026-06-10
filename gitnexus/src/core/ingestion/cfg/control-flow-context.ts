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
import type { CfgEdgeKind } from './types.js';

interface LoopFrame {
  readonly kind: 'loop';
  /** Block a `continue` jumps to (the loop header / update). */
  readonly continueTo: number;
  /** Block a `break` jumps to (the loop exit / join). */
  readonly breakTo: number;
  readonly label?: string;
}

interface SwitchFrame {
  readonly kind: 'switch';
  /** Block a `break` jumps to (after the switch). `continue` is invalid here. */
  readonly breakTo: number;
  readonly label?: string;
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

type Frame = LoopFrame | SwitchFrame | FinalizerFrame;

/** A resolved jump: its ultimate target + the finallys it crosses (inner→outer). */
export interface JumpResolution {
  readonly target: number;
  readonly finalizers: readonly FinalizerFrame[];
}

export class ControlFlowContext {
  private readonly stack: Frame[] = [];

  pushLoop(continueTo: number, breakTo: number, label?: string): void {
    this.stack.push({ kind: 'loop', continueTo, breakTo, label });
  }

  pushSwitch(breakTo: number, label?: string): void {
    this.stack.push({ kind: 'switch', breakTo, label });
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
    return this.resolve((f) => label === undefined || f.label === label);
  }

  /** Resolve a `continue`: like {@link resolveBreak} but only loop frames match. */
  resolveContinue(label?: string): JumpResolution | undefined {
    return this.resolve(
      (f) => f.kind === 'loop' && (label === undefined || f.label === label),
      (f) => (f as LoopFrame).continueTo,
    );
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

  /** Target block for a `break` (no finalizer info) — see {@link resolveBreak}. */
  breakTarget(label?: string): number | undefined {
    return this.resolveBreak(label)?.target;
  }

  /** Target block for a `continue` (no finalizer info) — see {@link resolveContinue}. */
  continueTarget(label?: string): number | undefined {
    return this.resolveContinue(label)?.target;
  }

  private resolve(
    matches: (f: LoopFrame | SwitchFrame) => boolean,
    targetOf: (f: LoopFrame | SwitchFrame) => number = (f) => f.breakTo,
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
