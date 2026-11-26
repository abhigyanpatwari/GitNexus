
import { runQuery } from '../data/query';

export function handleGet(id: string) {
  return runQuery('SELECT * FROM items WHERE id = ' + id);
}

export function handlePost(body: any) {
  return runQuery('INSERT INTO items VALUES ' + JSON.stringify(body));
}
