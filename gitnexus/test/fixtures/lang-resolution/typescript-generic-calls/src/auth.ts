import { verifyToken, BasePayload } from './token';

interface UserPayload extends BasePayload {
  userId: string;
}

export async function authenticateUser(token: string): Promise<UserPayload> {
  const payload = await verifyToken<UserPayload>(token, 'secret');
  return payload;
}
