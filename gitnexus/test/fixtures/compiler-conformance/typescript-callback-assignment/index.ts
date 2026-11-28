function fallback() {}
function first() {}
function second() {}

function invoke(callback?: () => void) {
  callback ??= fallback;
  callback();
}

export function choose(replace: boolean) {
  let handler = first;
  if (replace) handler = second;
  invoke(handler);
}
choose(true);
choose(false);
invoke();
