function anchor() {}
export function run(x: GlobalThing) { anchor(); x.hit(); }
export function inaccessible() {
  GlobalThing.stat();
  new GlobalThing().hit();
  hiddenFunction();
}
