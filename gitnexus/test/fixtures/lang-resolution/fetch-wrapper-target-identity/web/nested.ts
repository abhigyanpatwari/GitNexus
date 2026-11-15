export function owner() {
  function nestedRequest(url: string) {
    return fetch(url);
  }
  return nestedRequest('/api/nested');
}

export function sibling() {
  const nestedRequest = (channel: string) => channel;
  return nestedRequest('/api/sibling');
}
