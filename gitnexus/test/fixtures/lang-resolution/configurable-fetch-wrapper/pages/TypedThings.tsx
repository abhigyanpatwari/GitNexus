import { doRequest } from '../lib/http';

type Thing = { id: number; name: string };

export default function TypedThings() {
  const loadThings = async () => {
    const res = await doRequest<Thing[]>('/api/things');
    return res.data;
  };
  return null;
}
