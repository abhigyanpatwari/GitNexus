// A4: API contracts modelled as type aliases and interfaces — the common style
// in a TS frontend. Neither the alias node nor the members of either shape were
// indexed, so there was no graph path from a field to its consumers.
export type LiveModeConfig = {
  bookSlots: number;
  bookNotionalUsdt: number;
};

export interface LiveModeIface {
  ifaceSlots: number;
}

export function renderAlias(cfg: LiveModeConfig): number {
  return cfg.bookNotionalUsdt + cfg.bookSlots;
}

export function renderIface(cfg: LiveModeIface): number {
  return cfg.ifaceSlots;
}


// RV-4: the shapes that made an unanchored `property_signature` rule collide.
// Every inline object type below declares a UNIQUELY-named member, because a
// collision and a correct exclusion both leave exactly one node behind —
// counting ids cannot tell them apart, so the discriminator has to be a name
// that only the unanchored rule could ever produce.
export class Svc {
  retries = 1;

  run(opts: { retries: number; inlineParamOnlyKey: number }): number {
    return opts.retries + opts.inlineParamOnlyKey + this.retries;
  }
}

export interface Repo {
  retries: number;
  find(q: { retries: number; inlineQueryOnlyKey: number }): void;
}

// Nested object type: its members are not members of the alias.
export type NestedConfig = {
  host: string;
  db: { nestedOnlyKey: string };
};

// Inline RETURN type — the third position the unanchored rule reached.
// The TYPE annotation's member and the returned VALUE's key are named
// differently ON PURPOSE. They are separate rules with opposite expectations —
// an inline return TYPE must mint nothing (RV-4), while a returned literal's
// keys are a function's return shape and must mint (R3-4) — and sharing a name
// left the RV-4 assertion unable to tell which rule produced the node.
export function buildInline(): { inlineReturnTypeOnlyKey: number } {
  return { inlineReturnValueOnlyKey: 1 } as never;
}
