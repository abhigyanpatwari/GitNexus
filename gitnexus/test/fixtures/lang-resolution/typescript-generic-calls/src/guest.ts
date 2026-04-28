import { BasePayload } from './token';
import { TokenService } from './service';

interface GuestPayload extends BasePayload {
  sessionId: string;
}

export async function authenticateGuest(token: string): Promise<GuestPayload> {
  const svc = new TokenService();
  const payload = await svc.verify<GuestPayload>(token, 'guest-secret');
  return payload;
}
