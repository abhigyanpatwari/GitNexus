export async function httpGet(url: string) {
  const res = await fetch(url);
  return res.json();
}
