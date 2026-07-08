/**
 * Cloudflare Workers entry — scaffold for production DO path.
 * Full GameRoom/Lobby DO implementations follow docs/DESIGN.md PR 4a/4b.
 * Local/dev multiplayer: use @flight-sim/server-node.
 */
export { GameRoom } from './room/GameRoomStub.js';
export { Lobby } from './lobby/LobbyStub.js';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        ts: Date.now(),
        note: 'CF scaffold — use server-node for full multiplayer locally',
      });
    }
    return new Response('Flight-sim Worker scaffold. See docs/DESIGN.md', { status: 200 });
  },
};
