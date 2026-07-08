// `cafédoRequest` is a DIFFERENT function whose name ends in the configured
// wrapper `doRequest`, preceded by a non-ASCII letter. The consumer scan's
// left boundary must treat `é` as an identifier character (Unicode-aware) and
// NOT match `doRequest` here — otherwise this produces a spurious FETCHES edge
// to /api/things (#1852 review F10).
declare function cafédoRequest(path: string): Promise<unknown>;

export default function Accented() {
  const load = async () => {
    const res = await cafédoRequest('/api/things');
    return res;
  };
  return null;
}
