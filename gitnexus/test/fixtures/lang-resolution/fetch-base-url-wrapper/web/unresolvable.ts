const base = 'http://localhost:4747';
const scheme = 'http';
const host = 'localhost:4747';

// With the base stripped, nothing but a param is left: it would match /health.
export const loadAny = (id: string) => fetch(`${base}/${id}`);
// No path after the base, and a scheme/host pair: neither is a routable path.
export const loadRelative = () => fetch(`${base}api/repos`);
export const loadAbsolute = () => fetch(`${scheme}://${host}/api/repos`);
// A suffix or a query after a param leaves nothing static to match.
export const loadJson = (path: string) => fetch(`${base}/${path}.json`);
export const loadQuery = (path: string, query: string) => fetch(`${base}/${path}${query}`);
// `${kind}` matches /api/kinds/foo and /api/kinds/bar equally: no evidence for either.
export const loadKind = (kind: string) => fetch(`${base}/api/kinds/${kind}`);
