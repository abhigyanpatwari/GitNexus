import { doRequest } from '../lib/http';

class BaseClient {
  doRequest<T>(url: string) { return doRequest<T>(url); }
}
export class Client extends BaseClient {
  load() { return super.doRequest<string[]>('/api/things'); }
}
