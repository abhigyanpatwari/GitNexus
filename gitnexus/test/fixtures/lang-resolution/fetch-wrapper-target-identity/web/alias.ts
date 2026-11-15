import { request as aliasSend } from '@http';
export const loadAlias = () => aliasSend('/api/alias');

function forward(url: string) {
  return aliasSend(url);
}
export const loadForwarded = () => forward('/api/forwarded');
