
function target(): void {}
let first = target;
let second = first;
first = second;
second = first;
second();
