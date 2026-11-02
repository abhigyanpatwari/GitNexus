declare const other: { doRequest: (url: string) => unknown };
export const load = () => other.doRequest('/api/things');
