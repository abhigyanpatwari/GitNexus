function target() {}
function other() {}
function invoke(cb: false | (() => void)) { if (cb) cb(); }
export function run(enabled: boolean) {
  invoke(enabled && target);
  invoke(enabled ? other : target);
}
