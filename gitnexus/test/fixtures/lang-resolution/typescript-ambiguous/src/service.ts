import { BaseService, ILogger } from './models';
import { ConsoleLogger } from './logger';

export class UserService extends BaseService implements ILogger {
    log(message: string): void {
        const logger = new ConsoleLogger();
        logger.log(message);
    }

    getUsers(): string[] {
        return [];
    }
}
