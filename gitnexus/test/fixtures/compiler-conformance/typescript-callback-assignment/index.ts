function fallback() {}
function first() {}
function second() {}

function invoke(callback?: () => void) {
  callback = callback ?? fallback;
  callback();
}

let handler = first;
handler = second;
invoke(handler);
invoke();
