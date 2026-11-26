
export function formatResult(data: any) {
  return { ...data, formatted: true };
}

export function formatResponse(data: any) {
  return { status: 200, body: formatResult(data) };
}

export function serializeResult(data: any) {
  return JSON.stringify(data);
}
