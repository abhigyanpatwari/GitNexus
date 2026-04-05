import { DbLookup } from './db-lookup';
import { Formatter } from './formatter';

export class App {
    crossFileById() {
        const db = new DbLookup();
        db.find(42);
    }

    crossFileByName() {
        const db = new DbLookup();
        db.find('alice');
    }

    chainIntToFormat() {
        const db = new DbLookup();
        const fmt = new Formatter();
        const result = db.find(42);
        fmt.format(result);
    }

    chainNameToFormat() {
        const db = new DbLookup();
        const fmt = new Formatter();
        const result = db.find('alice');
        fmt.format(result);
    }
}
