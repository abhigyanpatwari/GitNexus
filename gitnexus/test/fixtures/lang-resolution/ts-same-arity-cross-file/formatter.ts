export class Formatter {
    format(value: number): string;
    format(value: string): string;
    format(value: number | string): string {
        return String(value);
    }
}
