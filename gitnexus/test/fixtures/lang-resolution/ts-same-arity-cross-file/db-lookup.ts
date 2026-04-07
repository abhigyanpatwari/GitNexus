import { ILookup } from './ilookup';

export class DbLookup implements ILookup {
    find(id: number): string;
    find(name: string): string;
    find(arg: number | string): string {
        return typeof arg === 'number' ? 'by-id' : 'by-name';
    }
}
