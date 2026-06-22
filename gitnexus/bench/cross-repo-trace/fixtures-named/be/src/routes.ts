import { Router } from 'express';

interface Req {
  body: { name: string };
  params: Record<string, string>;
}
interface Res {
  json: (value: unknown) => void;
}

const router = Router();

export function listUsers(req: Req, res: Res) {
  res.json([{ id: 1, name: 'Alice' }]);
}

export function createUser(req: Req, res: Res) {
  res.json({ id: 2, ...req.body });
}

router.get('/api/users', listUsers);
router.post('/api/users', createUser);

export default router;
