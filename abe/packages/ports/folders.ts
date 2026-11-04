// ports's folders and the folders each may import (ADR 0024). One folder per outside system.
import type { FolderTable } from '../testing/src/graph';

export default {
  folders: {
    '.': {
      imports: ['aws', 'azure-devops', 'claude-code', 'docker', 'git', 'github', 'mac'],
    },
    aws: { imports: ['azure-devops', 'claude-code', 'github', 'mac'] },
    'azure-devops': { imports: ['mac'] },
    'claude-code': { imports: ['docker', 'mac'] },
    docker: { imports: ['mac'] },
    git: { imports: ['claude-code', 'docker', 'mac'] },
    github: { imports: ['azure-devops', 'docker', 'git', 'mac'] },
    mac: { imports: [] },
  },
  unswept: {
    imports: ['.', 'aws', 'azure-devops', 'claude-code', 'docker', 'git', 'github', 'mac'],
    prose: ['aws', 'azure-devops', 'claude-code', 'docker', 'git', 'github', 'mac'],
  },
} satisfies FolderTable;
