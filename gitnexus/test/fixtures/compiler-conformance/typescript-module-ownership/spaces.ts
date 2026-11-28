import * as pack from './left.js';
      export namespace Inner { export namespace pack { export class Entity { save() {} } }
        export function shadowed(v: pack.Entity) { v.save(); } }
      class Entity { save() {} }
      export namespace Models { export class Entity { save() {} } }
      export function local(v: Models.Entity) { v.save(); }
      export function outer(v: pack.Entity) { v.save(); }