// Two DIFFERENT config objects that share a key name. A read of that name
// through an untyped receiver could mean either one, so the unique-name pass
// must emit nothing rather than pick — the safety property that keeps name
// inference from over-connecting on generic keys (id, name, data).
export const httpConfig = {
  sharedTimeoutMs: 1000,
};

export const dbConfig = {
  sharedTimeoutMs: 2000,
};

export function readsAmbiguous(cfg) {
  return cfg.sharedTimeoutMs;
}
