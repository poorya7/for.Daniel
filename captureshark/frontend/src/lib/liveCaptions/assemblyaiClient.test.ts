/**
 * Tests for `assemblyaiClient` — focuses on message routing + lifecycle
 * shape, NOT the real WebSocket. We supply a fake `WebSocketCtor` whose
 * lifecycle is driven by direct method calls from the test.
 */

import { describe, expect, it, vi } from "vitest";

import {
  openAssemblyAIClient,
  type AssemblyAIClient,
} from "./assemblyaiClient";

// --- Fake WebSocket --------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;
  static CONNECTING = 0;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  sent: Array<string | ArrayBufferLike> = [];

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  // Test helpers — drive lifecycle from outside.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receiveText(payload: string) {
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }
  receiveBinary(payload: ArrayBuffer) {
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }
  errorOut() {
    this.onerror?.();
  }
  closeWith(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  send(data: string | ArrayBufferLike) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function makeCtor(): {
  Ctor: typeof WebSocket;
  instances: FakeWebSocket[];
} {
  const instances: FakeWebSocket[] = [];
  const Ctor = function (url: string) {
    const ws = new FakeWebSocket(url);
    instances.push(ws);
    return ws;
  } as unknown as typeof WebSocket;
  // Static codes — `assemblyaiClient` reads them off the constructor.
  (Ctor as unknown as { OPEN: number }).OPEN = FakeWebSocket.OPEN;
  (Ctor as unknown as { CLOSED: number }).CLOSED = FakeWebSocket.CLOSED;
  (Ctor as unknown as { CLOSING: number }).CLOSING = FakeWebSocket.CLOSING;
  (Ctor as unknown as { CONNECTING: number }).CONNECTING =
    FakeWebSocket.CONNECTING;
  return { Ctor, instances };
}

// --- Tests -----------------------------------------------------------------

describe("openAssemblyAIClient", () => {
  it("resolves with a client once the socket opens, carrying token + params in the URL", async () => {
    const { Ctor, instances } = makeCtor();
    const onTurn = vi.fn();

    const promise = openAssemblyAIClient({
      token: "temp-abc",
      handlers: { onTurn },
      WebSocketCtor: Ctor,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain("/v3/ws?");
    expect(instances[0].url).toContain("token=temp-abc");
    expect(instances[0].url).toContain("speech_model=u3-rt-pro");
    expect(instances[0].url).toContain("sample_rate=16000");
    expect(instances[0].url).toContain("continuous_partials=true");
    expect(instances[0].url).toContain("include_partial_turns=true");
    expect(instances[0].url).toContain("interruption_delay=");
    expect(instances[0].url).toContain("min_turn_silence=");
    expect(instances[0].url).not.toContain("end_of_turn_confidence_threshold");

    instances[0].open();
    const client = await promise;
    expect(client.readyState()).toBe(FakeWebSocket.OPEN);
  });

  it("rejects with a timeout if the socket doesn't open in time", async () => {
    vi.useFakeTimers();
    const { Ctor } = makeCtor();
    const promise = openAssemblyAIClient({
      token: "t",
      handlers: { onTurn: vi.fn() },
      connectTimeoutMs: 100,
      WebSocketCtor: Ctor,
    });
    vi.advanceTimersByTime(101);
    await expect(promise).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });

  it("routes Begin / Turn / Termination messages to their handlers", async () => {
    const { Ctor, instances } = makeCtor();
    const handlers = {
      onBegin: vi.fn(),
      onTurn: vi.fn(),
      onTermination: vi.fn(),
    };
    const promise = openAssemblyAIClient({
      token: "t",
      handlers,
      WebSocketCtor: Ctor,
    });
    instances[0].open();
    await promise;

    instances[0].receiveText(
      JSON.stringify({ type: "Begin", id: "s-1", expires_at: 1234 }),
    );
    expect(handlers.onBegin).toHaveBeenCalledWith({
      type: "Begin",
      id: "s-1",
      expires_at: 1234,
    });

    instances[0].receiveText(
      JSON.stringify({
        type: "Turn",
        transcript: "hello there",
        end_of_turn: false,
      }),
    );
    expect(handlers.onTurn).toHaveBeenCalledWith({
      type: "Turn",
      transcript: "hello there",
      end_of_turn: false,
    });

    instances[0].receiveText(
      JSON.stringify({
        type: "Termination",
        audio_duration_seconds: 12,
        session_duration_seconds: 14,
      }),
    );
    expect(handlers.onTermination).toHaveBeenCalledOnce();
  });

  it("ignores unknown message types without erroring (forward compat)", async () => {
    const { Ctor, instances } = makeCtor();
    const handlers = { onTurn: vi.fn(), onError: vi.fn() };
    const promise = openAssemblyAIClient({
      token: "t",
      handlers,
      WebSocketCtor: Ctor,
    });
    instances[0].open();
    await promise;

    instances[0].receiveText(JSON.stringify({ type: "FutureType", foo: 1 }));
    expect(handlers.onTurn).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("surfaces malformed JSON via onError", async () => {
    const { Ctor, instances } = makeCtor();
    const handlers = { onTurn: vi.fn(), onError: vi.fn() };
    const promise = openAssemblyAIClient({
      token: "t",
      handlers,
      WebSocketCtor: Ctor,
    });
    instances[0].open();
    await promise;

    instances[0].receiveText("not json");
    expect(handlers.onError).toHaveBeenCalledOnce();
  });

  it("forceEndpoint sends a ForceEndpoint JSON message", async () => {
    const { Ctor, instances } = makeCtor();
    const promise = openAssemblyAIClient({
      token: "t",
      handlers: { onTurn: vi.fn() },
      WebSocketCtor: Ctor,
    });
    instances[0].open();
    const client = await promise;

    client.forceEndpoint();
    expect(instances[0].sent).toEqual([
      JSON.stringify({ type: "ForceEndpoint" }),
    ]);
  });

  it("sendPcm transmits the chunk only while open; terminate is idempotent", async () => {
    const { Ctor, instances } = makeCtor();
    const handlers = { onTurn: vi.fn() };
    const promise = openAssemblyAIClient({
      token: "t",
      handlers,
      WebSocketCtor: Ctor,
    });
    instances[0].open();
    const client: AssemblyAIClient = await promise;

    const samples = new Int16Array([1, 2, 3]);
    client.sendPcm(samples);
    expect(instances[0].sent).toHaveLength(1);
    expect(instances[0].sent[0]).toBe(samples.buffer);

    client.terminate();
    expect(instances[0].sent[1]).toBe(JSON.stringify({ type: "Terminate" }));
    expect(instances[0].readyState).toBe(FakeWebSocket.CLOSED);

    // Second terminate is a no-op.
    client.terminate();
    expect(instances[0].sent).toHaveLength(2);
  });
});
