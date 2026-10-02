import type { SocketLike } from "../../src/gateway/gateway.ts";

/** Stands in for WebSocket. Tests drive it with open(), receive() and drop(). */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  // ── test controls ──
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.close(code);
  }
}
