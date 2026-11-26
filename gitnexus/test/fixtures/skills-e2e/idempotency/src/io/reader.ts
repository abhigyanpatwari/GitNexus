
export function readFile(path: string) {
  return 'file contents from ' + path;
}

export function readStream(path: string) {
  return { path, stream: true };
}

export function close(handle: any) {
  return true;
}
