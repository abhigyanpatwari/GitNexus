/**
 * ControlFlowContext (issue #2081, M1).
 *
 * Resolves the targets of `break`/`continue` (plain and labeled) as the visitor
 * descends through loops and switches. Loops and switches push a target frame
 * on entry and pop it on exit; a labeled statement attaches its label to the
 * frame of the construct it labels, so `break outer` / `continue outer` resolve
 * against the right enclosing loop/switch rather than the nearest one.
 */

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

type Frame = LoopFrame | SwitchFrame;

export class ControlFlowContext {
  private readonly stack: Frame[] = [];

  pushLoop(continueTo: number, breakTo: number, label?: string): void {
    this.stack.push({ kind: 'loop', continueTo, breakTo, label });
  }

  pushSwitch(breakTo: number, label?: string): void {
    this.stack.push({ kind: 'switch', breakTo, label });
  }

  pop(): void {
    this.stack.pop();
  }

  /**
   * Target block for a `break`. With a label, the nearest enclosing frame
   * carrying that label (loop or switch); without, the nearest frame of any
   * kind. Returns `undefined` if there is no valid target (malformed input).
   */
  breakTarget(label?: string): number | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (label === undefined || f.label === label) return f.breakTo;
    }
    return undefined;
  }

  /**
   * Target block for a `continue`. With a label, the nearest enclosing **loop**
   * carrying that label; without, the nearest loop (switches are skipped — you
   * cannot `continue` a switch). Returns `undefined` if there is no valid loop.
   */
  continueTarget(label?: string): number | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f.kind !== 'loop') continue;
      if (label === undefined || f.label === label) return f.continueTo;
    }
    return undefined;
  }
}
