import { BasePayload } from './token';

export class TokenService {
  verify<T extends BasePayload>(token: string, secret: string): T {
    return JSON.parse(Buffer.from(token, 'base64').toString()) as T;
  }
}
