// hooks's folders and the folders each may import (ADR 0024).
import type { FolderTable } from '../testing/src/graph';

export default {
  folders: {
    '.': { imports: [] },
  },
  unswept: {
    imports: ['.'],
    prose: ['.'],
  },
} satisfies FolderTable;
