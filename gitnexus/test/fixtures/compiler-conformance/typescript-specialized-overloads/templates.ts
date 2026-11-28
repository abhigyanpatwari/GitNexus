class Fallback { label() {} }
class Exact extends Fallback { override label() {} }

function select(value: string): Fallback;
function select(value: 'foo'): Exact;
function select(value: '${part}'): Exact;
function select(value: string) {
  return value === 'foo' || value === '${part}' ? new Exact() : new Fallback();
}

export function checkTemplates(part: string) {
  const plain = select(`foo`);
  plain.label();
  const cooked = select(`f\u006fo`);
  cooked.label();
  const escaped = select(`\${part}`);
  escaped.label();
  const dynamic = select(`${part}`);
  dynamic.label();
  const unmatched = select(`other`);
  unmatched.label();
}
