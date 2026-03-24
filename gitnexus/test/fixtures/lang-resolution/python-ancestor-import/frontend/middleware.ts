// TypeScript middleware — should NOT be resolved by Python imports
export function handleRequest(req: Request): Response {
  return new Response("ok");
}
