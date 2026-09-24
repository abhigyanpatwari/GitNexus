import { Repo } from './repository';

// The two shapes the dispatch closure exists to handle, and which TypeScript
// heritage capture silently dropped before #2842's review.

// (1) Abstract intermediate: the interface reaches DiskRepo only through
// BaseRepo. The abstract declaration itself is bodiless and must be walked
// THROUGH, not emitted to — tsc's own Go-to-Implementation does the same.
export abstract class BaseRepo implements Repo {
    abstract save(entity: string): boolean;
}

export class DiskRepo extends BaseRepo {
    save(entity: string): boolean {
        return entity.length > 1;
    }
}

// (2) Interface extension: `Archiving extends Repo` means an implementor of
// Archiving is an implementor of Repo, two hops from the receiver's type.
export interface Archiving extends Repo {
    archive(): void;
}

export class ColdRepo implements Archiving {
    save(entity: string): boolean {
        return entity !== 'cold';
    }
    archive(): void {}
}
