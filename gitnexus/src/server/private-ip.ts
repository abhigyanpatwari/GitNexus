const parseIpv4Octets = (hostname: string): number[] | null => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
};

export const isRfc1918PrivateIpv4 = (hostname: string): boolean => {
  const octets = parseIpv4Octets(hostname);
  if (octets === null) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
