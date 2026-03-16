export interface ILogger {
    log(message: string): void;
}

export class BaseService {
    protected name: string = '';

    getName(): string {
        return this.name;
    }
}
