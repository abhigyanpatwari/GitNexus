export function listUsers(_req, res) {
  return res.json({ users: [] });
}

export function createUser(_req, res) {
  return res.json({ createdId: 'new' });
}

export const auth = {
  getCurrentUser(_req, res) {
    return res.json({ accountId: 'current' });
  },
};
