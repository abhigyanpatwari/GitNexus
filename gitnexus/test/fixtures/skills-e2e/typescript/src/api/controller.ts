
import { runQuery } from '../data/query';
import { formatResponse } from '../data/format';

export function handleGet(id: string) {
  const data = runQuery('SELECT * FROM items WHERE id = ' + id);
  return formatResponse(data);
}

export function handlePost(body: any) {
  const result = runQuery('INSERT INTO items VALUES ' + JSON.stringify(body));
  return formatResponse(result);
}
