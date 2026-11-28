export const visited: string[] = [];
function left() { visited.push('left'); }
function right() { visited.push('right'); }
function wrap(fn: () => void) { return fn; }
const wrappers = { wrap };

if (Math.random() < 0.5) {
  const branchTask = wrap(() => left());
  branchTask();
} else {
  const branchTask = wrappers.wrap(function () { right(); });
  branchTask();
}

const moduleTask = wrap(() => left());
{
  const moduleTask = () => right();
  moduleTask();
}
moduleTask();

{
  const uniqueTask = wrap(() => left());
  uniqueTask();
}
{
  const uniqueTask = [1].map(value => value + 1);
  void uniqueTask;
}

function both(first: () => void, second: () => void) {
  return () => { first(); second(); };
}
function leftExtra() { visited.push('left-extra'); }
function rightExtra() { visited.push('right-extra'); }
{
  const grouped = both(() => left(), () => leftExtra());
  grouped();
}
{
  const grouped = both(() => right(), function () { rightExtra(); });
  grouped();
}
const moduleGroup = both(() => left(), () => right());
moduleGroup();
