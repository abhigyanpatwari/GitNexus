function diamondRequest(url: string) {
  return fetch(url);
}
export { diamondRequest, diamondRequest as diamondSend };
