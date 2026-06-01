import * as ns from './base.js';
import { Base } from './base.js';

// Qualified base: `extends ns.Base` parses as a class_heritage holding a
// member_expression (object: identifier `ns`, property: property_identifier
// `Base`). The registry-primary synth resolves it by its trailing
// property_identifier (`Base`), matching the legacy @heritage leg's
// normalizeSupertypeName reduction (member_expression -> `Base`).
export class Service extends ns.Base {
  base() {
    return 'service';
  }
}

// Bare control: `extends Base` (direct identifier) — its handling is unchanged
// (byte-identical to the pre-fix simple-base path).
export class Plain extends Base {
  base() {
    return 'plain';
  }
}
