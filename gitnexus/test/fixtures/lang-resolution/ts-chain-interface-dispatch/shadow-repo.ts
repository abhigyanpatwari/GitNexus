import { SqlRepo } from './sql-repo';

// A subclass adding a STATIC helper that shares its name with the instance
// method it inherits — an ordinary shape (`static create` / `static serialize`
// mirroring an instance method). A `Repo`-typed receiver can hold a ShadowRepo,
// but dispatches to the INHERITED SqlRepo.save; the static below is reachable
// only as `ShadowRepo.save(...)`, never through an instance. It must never
// appear in the interface-dispatch fan-out.
export class ShadowRepo extends SqlRepo {
    static save(entity: string): boolean {
        return entity === '';
    }
}
