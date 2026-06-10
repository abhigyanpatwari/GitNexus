import { doRequest } from '../lib/http';

export default function ThingsList() {
  const loadThings = async () => {
    const res = await doRequest('/api/things');
    return res.data;
  };
  return null;
}
