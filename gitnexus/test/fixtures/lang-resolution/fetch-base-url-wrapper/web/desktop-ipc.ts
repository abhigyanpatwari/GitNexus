// Another module's request() shares the name of the fetch wrapper in
// client-request.ts, but sends to an IPC channel: forwarding to it proves no URL.
declare const ipcRenderer: { invoke(event: string, channel: string): Promise<unknown> };

export function request(channel: string) {
  return ipcRenderer.invoke('navigate', channel);
}
