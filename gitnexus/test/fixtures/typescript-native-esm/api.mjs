function hidden() {}
function local() {}

export { local as renamed };
export function direct() {}
export default function stable() {}

if (typeof module !== 'undefined') {
  module.exports = { legacy() {} };
}
