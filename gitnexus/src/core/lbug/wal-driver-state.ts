/**
 * Shared "is the manual WAL-checkpoint driver running?" flag (#2264).
 *
 * Lives in its own tiny module — NOT in lbug-adapter — on purpose: the
 * wal-checkpoint-driver toggles it and lbug-adapter's `streamQuery` reads it, and
 * putting it here keeps that one-bit coupling out of the big, heavily-mocked
 * lbug-adapter surface. (Importing it from lbug-adapter forced every test that
 * mocks lbug-adapter + loads the real driver to also stub the toggle — a brittle
 * ripple this module avoids.)
 *
 * streamQuery is deliberately not wrapped in withConnLock (its per-row callback can
 * re-enter the adapter), so it must refuse to run while the driver is live —
 * otherwise its unlocked per-row reads could race a CHECKPOINT on the shared
 * connection. The serve/read path never starts the driver, so this stays false
 * there.
 */
let walDriverActive = false;

/** Toggled by the WAL-checkpoint driver's start (true) / stop (false). */
export const markWalDriverActive = (active: boolean): void => {
  walDriverActive = active;
};

/** True while the manual WAL-checkpoint driver is running. @see streamQuery */
export const isWalDriverActive = (): boolean => walDriverActive;
