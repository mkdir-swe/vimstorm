import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowJsonSchema } from './schema';

/**
 * yaml-language-server reads it from here (nvim/lua/config/yamlls.lua): one stable path. A box's
 * base image ships a copy from its own build context (`images/base`, as /opt/abe/schema/), since
 * neither `images/build.sh` nor a box's `workspace up` sends packages/ to the build.
 */
const FILES = [
  ['core/schema', '../../../schema/workflow.schema.json'],
  ['images/base', '../../../../../images/base/workflow.schema.json'],
] as const;

test.each(FILES)(
  '%s/workflow.schema.json is the zod schemas’ (ABE_WRITE_SCHEMA=1 writes it)',
  (_, rel) => {
    const file = join(import.meta.dir, rel);
    const text = `${JSON.stringify(workflowJsonSchema(), null, 2)}\n`;

    if (process.env.ABE_WRITE_SCHEMA === '1') writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  },
);
