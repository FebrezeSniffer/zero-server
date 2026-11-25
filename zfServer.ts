// Drop-in client for the ZEROFRAME server. Replaces the Quick storage calls in lib.ts and Net.ts
// when the game runs as a standalone website.
export const SERVER = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ZF_SERVER || 'http://localhost:8080';
const WS_URL = SERVER.replace(/^http/, 'ws') + '/live';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(SERVER + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error || `Server error ${r.status}`);
  return body as T;
}

// ---------- leaderboards / duels / tags (same shapes as lib.ts) ----------
export const submitScore = (name: string, mode: string, r: object) => api('/api/scores', { method: 'POST', body: JSON.stringify({ ...r, name, mode }) });
export const loadScores = (mode: string) => api<unknown[]>(`/api/scores?mode=${encodeURIComponent(mode)}`);
export const createDuel = (d: object) => api('/api/duels', { method: 'POST', body: JSON.stringify(d) });
export const getDuel = (id: string) => api(`/api/duels/${encodeURIComponent(id)}`).catch((e) => { if (/No duel/.test(e.message)) return null; throw e; });
export const saveDuel = (d: { id: string }) => api(`/api/duels/${d.id}`, { method: 'PUT', body: JSON.stringify(d) });
export const loadDuels = () => api<unknown[]>('/api/duels');
const deviceId = () => { let id = localStorage.getItem('zf-device'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('zf-device', id); } return id; };
export const getTag = () => api<{ tag: string | null }>(`/api/tags/${deviceId()}`).then((r) => r.tag);
export const setTag = (tag: string) => api(`/api/tags/${deviceId()}`, { method: 'PUT', body: JSON.stringify({ tag }) });

// ---------- live 1v1 ----------
export interface OppState { x: number; y: number; z: number; yaw: number; pitch: number; lean: number; crouch: number; weapon: number; at: number }
export interface LiveEvents {
  onHosted?: (code: string) => void;
  onStart?: (role: 'host' | 'guest', vs: string, endsAt: number) => void;
  onState?: (s: OppState) => void;
  onFire?: (weapon: number) => void;
  onDamage?: (hp: number, head: boolean) => void;   // you got hit; hp is authoritative
  onConfirm?: (oppHp: number, head: boolean) => void; // your hit landed
  onKill?: (killer: 'host' | 'guest', head: boolean, score: { host: number; guest: number }) => void;
  onRespawn?: (who: 'host' | 'guest') => void;
  onEnd?: (winner: 'host' | 'guest' | 'draw', reason: string, score: { host: number; guest: number }) => void;
  onLeft?: () => void;
  onError?: (msg: string) => void;
}
export function connectLive(ev: LiveEvents) {
  const ws = new WebSocket(WS_URL);
  const q: string[] = []; let open = false;
  const tx = (m: object) => { const s = JSON.stringify(m); if (open) ws.send(s); else q.push(s); };
  ws.onopen = () => { open = true; for (const s of q.splice(0)) ws.send(s); };
  ws.onerror = () => ev.onError?.('Could not reach the game server.');
  ws.onclose = () => { open = false; };
  ws.onmessage = (e) => {
    let m: Record<string, unknown>; try { m = JSON.parse(e.data); } catch { return; }
    switch (m.t) {
      case 'hosted': ev.onHosted?.(m.code as string); break;
      case 'start': ev.onStart?.(m.role as 'host' | 'guest', m.vs as string, m.endsAt as number); break;
      case 'state': ev.onState?.(m as unknown as OppState); break;
      case 'fire': ev.onFire?.(m.weapon as number); break;
      case 'damage': ev.onDamage?.(m.hp as number, !!m.head); break;
      case 'confirm': ev.onConfirm?.(m.hp as number, !!m.head); break;
      case 'kill': ev.onKill?.(m.killer as 'host' | 'guest', !!m.head, m.score as { host: number; guest: number }); break;
      case 'respawn': ev.onRespawn?.(m.who as 'host' | 'guest'); break;
      case 'end': ev.onEnd?.(m.winner as 'host' | 'guest' | 'draw', m.reason as string, m.score as { host: number; guest: number }); break;
      case 'left': ev.onLeft?.(); break;
      case 'error': ev.onError?.(m.error as string); break;
    }
  };
  return {
    host: (name: string) => tx({ t: 'host', name }),
    join: (code: string, name: string) => tx({ t: 'join', code, name }),
    sendState: (s: Omit<OppState, 'at'>) => tx({ t: 'state', ...s }),
    sendFire: (weapon: number) => tx({ t: 'fire', weapon }),
    sendHit: (dmg: number, head: boolean) => tx({ t: 'hit', dmg, head }),
    close: () => ws.close(),
  };
}
