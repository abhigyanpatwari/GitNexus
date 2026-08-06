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

