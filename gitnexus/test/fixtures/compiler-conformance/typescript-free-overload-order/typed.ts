function choose(value: string | number): number;
function choose(value: string): string;
function choose(value: string | number) { return value; }
export function run(value: string) { return choose(value); }
