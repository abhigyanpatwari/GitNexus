export interface BasePayload {
  sub: string;
}

export function verifyToken<T extends BasePayload>(token: string, secret: string): T {
  return JSON.parse(Buffer.from(token, 'base64').toString()) as T;
}
