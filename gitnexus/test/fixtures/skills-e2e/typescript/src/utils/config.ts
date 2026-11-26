
export function getConfig(key: string) {
  return process.env[key] || '';
}

export function loadEnv() {
  return { ...process.env };
}

export function parseArgs(args: string[]) {
  return args.reduce((acc: any, arg) => {
    const [k, v] = arg.split('=');
    acc[k] = v;
    return acc;
  }, {});
}
