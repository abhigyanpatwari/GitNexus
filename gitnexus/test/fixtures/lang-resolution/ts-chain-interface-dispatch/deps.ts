import { Repo } from './repository';
import { PlainCache } from './plain-cache';
import { SqlRepo } from './sql-repo';
import { ShadowRepo } from './shadow-repo';

/**
 * Declared field types only. No initializer and no constructor assignment, so
 * the field's type comes from the annotation rather than from an inferred RHS.
 */
export class Deps {
    repo!: Repo;
    cache!: PlainCache;
    sql!: SqlRepo;
    shadow!: ShadowRepo;
}
