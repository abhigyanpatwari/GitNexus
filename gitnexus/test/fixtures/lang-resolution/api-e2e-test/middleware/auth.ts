export function withAuth(handler: Function) {
  return async (req: Request) => {
    const token = req.headers.get('Authorization');
    if (!token) throw new Error('Unauthorized');
    return handler(req);
  };
}
