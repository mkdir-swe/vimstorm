import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { azTokens } from './az';

let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'az-tokens-'));
  writeFileSync(
    join(bin, 'az'),
    `#!/bin/sh
echo "ERROR: AADSTS53003: Access has been blocked by Conditional Access policies." >&2
exit 1
`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe('Azure DevOps tokens', () => {
  test("Entra's refusal is named with what to do (#237)", async () => {
    const got = await azTokens({ PATH: `${bin}:/usr/bin:/bin` }).get();

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.message).toBe(
      "no Azure DevOps token from az: Microsoft Entra's Conditional Access blocked this sign-in (AADSTS53003): a policy refuses this device or place. An Entra admin must allow it.",
    );
  });
});
