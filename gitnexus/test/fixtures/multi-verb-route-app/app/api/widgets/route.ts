// Next.js App Router filesystem route → /api/widgets (method-less identity).
// Coexists with the Spring @GetMapping("/widgets") decorator route at the same
// URL: the filesystem node keeps its URL-only id, the decorator node is keyed
// `GET /api/widgets`.
export async function GET() {
  return new Response('[]');
}
