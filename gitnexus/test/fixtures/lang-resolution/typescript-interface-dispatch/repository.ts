export interface IRepository {
    find(id: number): string;
    save(entity: string): boolean;
}
