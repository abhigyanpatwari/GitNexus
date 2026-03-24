export function withRateLimit(handler: Function) {
  return async (req: Request) => {
    return handler(req);
  };
}
