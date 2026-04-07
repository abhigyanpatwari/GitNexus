export interface IRepository {
    find(id: number): string;
    find(name: string): string;
    save(data: string): void;
}
