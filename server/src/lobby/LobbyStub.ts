/** Placeholder Durable Object — implement per DESIGN.md PR 4b. */
export class Lobby {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_state: any, _env: any) {}
  async fetch(): Promise<Response> {
    return new Response('Lobby DO stub', { status: 501 });
  }
}
