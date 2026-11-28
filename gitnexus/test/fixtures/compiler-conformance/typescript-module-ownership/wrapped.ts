
function wrap(fn: () => void) { return fn; }
function callback() {}
export { callback as exposed };
export default wrap(function callback() {});
