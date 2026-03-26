export function GdprExport() {
  const data = fetch('/api/gdpr/export', { method: 'POST' }).then(r => r.json());
  const link = document.createElement('a');
  link.href = data.url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  return null;
}
