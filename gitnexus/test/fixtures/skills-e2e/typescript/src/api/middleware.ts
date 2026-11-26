
import { validateToken } from '../utils/validator';
import { logRequest } from '../utils/logger';

export function authMiddleware(req: any) {
  validateToken(req.headers.auth);
  logRequest('auth check');
  return true;
}

export function corsMiddleware(req: any) {
  logRequest('cors check');
  return { allowed: true };
}
