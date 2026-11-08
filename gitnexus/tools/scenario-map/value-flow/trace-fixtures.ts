import { createHash } from 'node:crypto';
import { FixtureCapture } from '../path-coverage/fixture-capture.js';

/** Attempt-local identities; separate identical repositories retain distinct ordinals. */
export class TraceFixtureRoots {
  readonly roots = new Map<string, string>();
  private readonly ordinals = new Map<string, number>();

  clear(): void {
    this.roots.clear();
    this.ordinals.clear();
  }

  capture(root: unknown): void {
    const capture = new FixtureCapture();
    capture.repository(root);
    const snapshot = Object.values(capture.snapshots)[0];
    if (!snapshot) return;
    this.roots.delete(snapshot.root);
    if (snapshot.unresolved.length || !snapshot.files.length) return;
    const ordinal = this.ordinals.get(snapshot.root) ?? this.ordinals.size;
    this.ordinals.set(snapshot.root, ordinal);
    const digest = createHash('sha256').update(JSON.stringify(snapshot.files)).digest('hex');
    this.roots.set(snapshot.root, `fixture:${ordinal}:${digest}`);
  }
}
