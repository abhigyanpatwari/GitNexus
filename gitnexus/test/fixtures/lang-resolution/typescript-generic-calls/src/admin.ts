import { verifyToken } from './token';

interface AdminPayload extends BasePayload {
  role: string;
}

interface BasePayload {
  sub: string;
}

export async function authenticateAdmin(token: string): Promise<AdminPayload> {
  const payload = await verifyToken<AdminPayload>(token, 'admin-secret');
  return payload;
}
