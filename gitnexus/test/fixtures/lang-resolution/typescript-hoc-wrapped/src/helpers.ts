// Shared helpers used as call targets in HOC-wrapped fixture files. Each
// helper is a plain named arrow so we can assert exact `Caller → helper`
// edges without confounding cross-file resolution.

export const helper = (label: string): string => label.toUpperCase();

export const doStuff = (n: number): number => n + 1;

export const cn = (...classes: string[]): string => classes.filter(Boolean).join(' ');

export const fmt = (value: number): string => `[${value}]`;
