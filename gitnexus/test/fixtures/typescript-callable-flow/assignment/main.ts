
function target(): void {}
function invoke(callback: () => void): void { callback(); }
function outer(cb: () => void): void { invoke(cb); }

const first = target;
const second = first;
second();
outer(second);
