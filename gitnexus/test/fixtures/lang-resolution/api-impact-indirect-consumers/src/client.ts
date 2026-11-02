// The one function that sends the request; its callers never mention the URL.
export async function fetchRepos() {
  const res = await fetch('/api/repos');
  return res.json();
}

// A helper defined on the same line as the request: the request still belongs
// to fetchFile, not to decode.
export function fetchFile(path: string) {
  const decode = (res: Response) => res.json(); return fetch(`/api/file?path=${path}`).then(decode);
}

export function describeClient() {
  return 'repos client';
}
