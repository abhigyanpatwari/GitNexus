import { Repo } from './repository';

export class SqlRepo implements Repo {
    save(entity: string): boolean {
        return entity.length > 0;
    }
}
