/**
 * `abe box attach` and `abe box forward` (#91, ADR 0021): this terminal or a local port on a box,
 * over SSH through the org's EC2 Instance Connect Endpoint. Both run in the `abe` client (they
 * take the terminal or stay up), never as a reply of `serve`.
 */
import { z } from 'zod';

/** What an attach ended with: the remote's exit, 255 when the connection could not be kept. */
export const BoxAttachData = z.object({ box: z.string(), exit: z.number().int() });
export type BoxAttachData = z.infer<typeof BoxAttachData>;

/** A forward while it stays up: `127.0.0.1:<local>` reaches `<port>` on the box. */
export const BoxForwardData = z.object({
  box: z.string(),
  port: z.number().int().positive(),
  local: z.number().int().positive(),
});
export type BoxForwardData = z.infer<typeof BoxForwardData>;

export const boxForwardText = (f: BoxForwardData): string =>
  `127.0.0.1:${f.local} → ${f.box}:${f.port} (Ctrl-C ends it)\n`;
