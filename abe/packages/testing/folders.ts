// testing's folders and the folders each may import (ADR 0024). One folder per kind of fake.
import type { FolderTable } from '../testing/src/graph';

export default {
  folders: {
    '.': { imports: ['in-process', 'screens', 'servers', 'tools'] },
    'in-process': { imports: ['servers', 'tools'] },
    screens: { imports: ['in-process'] },
    servers: { imports: [] },
    tools: { imports: [] },
  },
  unswept: {
    imports: ['.', 'in-process', 'screens', 'servers', 'tools'],
    prose: ['screens'],
  },
} satisfies FolderTable;
