import { ILogger } from './models';

export class ConsoleLogger implements ILogger {
    log(message: string): void {
        console.log(message);
    }
}
