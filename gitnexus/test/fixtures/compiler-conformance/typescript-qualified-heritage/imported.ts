import * as api from "./lib.js";
import { Models as Imported } from "./lib.js";
class Base { hit() {} }
export class Branch extends api.Base { override hit() {} }
export class ImportedUser extends Imported.User { override save() { super.save(); } }
