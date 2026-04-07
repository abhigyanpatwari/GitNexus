import { IRepository } from './repository';

export class SqlRepository implements IRepository {
    find(id: number): string;
    find(name: string): string;
    find(arg: number | string): string {
        return typeof arg === 'number' ? 'found-by-id' : 'found-by-name';
    }
    save(data: string): void {
        console.log(data);
    }
}
