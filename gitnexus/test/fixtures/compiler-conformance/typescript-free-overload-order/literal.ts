function choose(value: string): string;
function choose(value: number): number;
function choose(value: string | number) { return value; }
export function run() { return choose(42); }
