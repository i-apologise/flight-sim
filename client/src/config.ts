export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
export const WS_BASE = import.meta.env.VITE_WS_BASE ?? '';

export function httpUrl(path: string): string {
  if (API_BASE) return `${API_BASE.replace(/\/$/, '')}${path}`;
  return path;
}

export function wsUrl(roomId: string): string {
  if (WS_BASE) return `${WS_BASE.replace(/\/$/, '')}/ws/${roomId}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/${roomId}`;
}
