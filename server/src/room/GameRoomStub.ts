/** Placeholder Durable Object — implement per DESIGN.md PR 4a. */
export class GameRoom {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_state: any, _env: any) {}
  async fetch(): Promise<Response> {
    return new Response('GameRoom DO stub', { status: 501 });
  }
}
