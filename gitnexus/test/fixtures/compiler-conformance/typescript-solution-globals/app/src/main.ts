/// <reference path="../../types/declared.ts" />
export function run() {
  helper();
  new Legacy().go();
  fromReference();
  parentSelected();
}
export function rejectedGlobal() { orphanGlobal(); }
