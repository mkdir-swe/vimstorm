/**
 * What the fake `ssh` and the fake box behind the fake Instance Connect Endpoint say to each
 * other through abe's real tunnel. A frame is one type byte, a 4-byte length and the payload.
 * Only the two fakes read it. The tunnel carries its bytes as it would carry ssh's.
 */

export const FRAME = {
  /** From ssh, the connection's ask as JSON `Hello`. */
  hello: 0x48,
  /** From ssh, stdin bytes. An empty one ends stdin. */
  input: 0x49,
  /** From the box, stdout, stderr and the command's exit as one byte. */
  out: 0x4f,
  err: 0x52,
  exit: 0x58,
  /** From the box, a `-L` connection reached its port or a master's connection is up. A `-L` is raw bytes both ways after it. */
  ready: 0x4b,
  /** One channel's frame on a master's connection, sent both ways. */
  chan: 0x4d,
  /** From ssh in a channel, its client went. The box stops the command. */
  close: 0x5a,
} as const;

export type Hello = {
  /** The key ssh offers (`ssh-ed25519 AAAA…`), checked against what was pushed. */
  key: string;
  user: string;
  /** The remote command as ssh sends it, its words joined by spaces. Null is a login shell. */
  command: string | null;
  tty: boolean;
  /** A `-L` connection relays raw bytes to this port on the box. */
  forward?: number;
  /** A ControlMaster's connection has no command. Each call comes as a channel on it. */
  mux?: boolean;
};

/** A channel's first frame on a master's connection, a `hello` inside `chan`. */
export type ChannelOpen = { command: string | null; tty: boolean };

export const frame = (type: number, payload: Uint8Array | string): Uint8Array => {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(5 + body.length);

  out[0] = type;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);

  return out;
};

/** Reads frames out of a byte stream as they complete. */
export const reader = (onFrame: (type: number, payload: Uint8Array) => void) => {
  let held = new Uint8Array(0);

  return (chunk: Uint8Array) => {
    const both = new Uint8Array(held.length + chunk.length);

    both.set(held);
    both.set(chunk, held.length);
    held = both;
    while (held.length >= 5) {
      const length = new DataView(held.buffer, held.byteOffset).getUint32(1);

      if (held.length < 5 + length) break;
      onFrame(held[0] ?? 0, held.slice(5, 5 + length));
      held = held.slice(5 + length);
    }
  };
};

/** `type` / `payload` as channel `ch`'s frame on a master's connection. */
export const chan = (ch: number, type: number, payload: Uint8Array | string): Uint8Array => {
  const inner = frame(type, payload);
  const body = new Uint8Array(4 + inner.length);

  new DataView(body.buffer).setUint32(0, ch);
  body.set(inner, 4);

  return frame(FRAME.chan, body);
};

/** A `chan` frame's payload: its channel and the frame inside. */
export const unchan = (payload: Uint8Array): { ch: number; type: number; body: Uint8Array } => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  return { ch: view.getUint32(0), type: payload[4] ?? 0, body: payload.slice(9) };
};
