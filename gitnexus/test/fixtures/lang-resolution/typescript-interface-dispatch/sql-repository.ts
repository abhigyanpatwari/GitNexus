import { IRepository } from './repository';

export class SqlRepository implements IRepository {
    find(id: number): string {
        return "found";
    }

    save(entity: string): boolean {
        return true;
    }
}
