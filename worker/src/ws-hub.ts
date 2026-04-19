import type { AgentEvent } from "./types";

const REPLAY_BUFFER_SIZE = 50;

/**
 * Durable Object WebSocket Hub.
 *
 * Maintains WebSocket connections with frontend clients.
 * Worker notifies this DO after each operation (scan/trade/settle/evolve),
 * and the DO broadcasts AgentEvent to all connected clients.
 *
 * Ring buffer replays recent events to newly connected clients so they
 * don't see an empty feed after page refresh.
 */
export class LiveHub {
  private state: DurableObjectState;
  private sessions: Set<WebSocket> = new Set();
  private replayBuffer: string[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.getWebSockets().forEach(ws => this.sessions.add(ws));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    if (url.pathname === "/status") {
      return Response.json({
        connections: this.sessions.size,
        timestamp: new Date().toISOString(),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocket(request: Request): Response {
    if (this.sessions.size >= 1000) {
      return new Response("Too many connections", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    const welcome: AgentEvent = {
      type: "CONNECTED",
      timestamp: new Date().toISOString(),
      payload: { connections: this.sessions.size },
    };
    server.send(JSON.stringify(welcome));

    for (const msg of this.replayBuffer) {
      server.send(msg);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    let event: AgentEvent;
    try {
      event = await request.json() as AgentEvent;
    } catch {
      return Response.json({ error: "Invalid event" }, { status: 400 });
    }

    const message = JSON.stringify(event);

    if (event.type !== "CONNECTED") {
      this.replayBuffer.push(message);
      if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
        this.replayBuffer.shift();
      }
    }

    let sent = 0;
    for (const ws of this.sessions) {
      try {
        ws.send(message);
        sent++;
      } catch {
        this.sessions.delete(ws);
      }
    }

    return Response.json({ sent, total: this.sessions.size });
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }
}
