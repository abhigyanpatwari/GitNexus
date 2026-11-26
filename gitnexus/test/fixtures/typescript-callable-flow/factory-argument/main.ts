
function target(): void {}
function factory(): () => void { return target; }
function invoke(callback: () => void): void { callback(); }
invoke(factory());
