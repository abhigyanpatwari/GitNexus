
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const assigned = target;
invoke(assigned);
