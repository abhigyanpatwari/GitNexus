import { doRequest } from '../lib/http';

export class Client {
  doRequest = doRequest;
  load() { return this.doRequest<string[]>('/api/things'); }
}
