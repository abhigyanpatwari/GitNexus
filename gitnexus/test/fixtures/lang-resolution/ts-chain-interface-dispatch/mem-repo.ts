import { Repo } from './repository';

export class MemRepo implements Repo {
    save(entity: string): boolean {
        return entity !== '';
    }
}
