// track() calls fetch, but its first parameter is an event, not a URL, so a
// function forwarding its own argument to track() is not a fetch wrapper.
export function track(event: string) {
  return fetch('/api/events', { method: 'POST', body: event });
}

export function navigate(path: string) {
  track(path);
  window.history.pushState(null, '', path);
}

navigate('/settings');
