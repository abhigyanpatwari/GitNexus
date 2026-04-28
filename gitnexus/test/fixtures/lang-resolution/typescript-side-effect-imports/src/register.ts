declare const globalThis: { __registry?: string[] };
(globalThis.__registry ??= []).push('module-A');
