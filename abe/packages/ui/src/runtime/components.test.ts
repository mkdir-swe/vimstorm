import { describe, expect, test } from 'bun:test';
import { agentStatus, type Kind, KINDS, Node } from './components';
import { readAppLine } from './protocol';
import { reviewPaneSample } from '@abe/testing';

describe('the component set', () => {
  test('is closed: a kind outside it fails the type check and the parse', () => {
    // @ts-expect-error: Chooser is not in the set this contract draws
    const outside: Node = { kind: 'Chooser', props: { title: 'x' } };

    expect(Node.safeParse(outside).success).toBe(false);
  });

  test('refuses a prop a component does not have', () => {
    expect(
      Node.safeParse({ kind: 'Badge', props: { text: 'x', hue: 'good', size: 3 } }).success,
    ).toBe(false);
    expect(Node.safeParse({ kind: 'Badge', props: { text: 'x', hue: 'pink' } }).success).toBe(
      false,
    );
  });

  test('checks children all the way down', () => {
    const tree = {
      kind: 'Island',
      props: {},
      children: [
        { kind: 'Stack', props: { direction: 'row' }, children: [{ kind: 'Oops', props: {} }] },
      ],
    };

    expect(Node.safeParse(tree).success).toBe(false);
  });

  test.each(KINDS)('%s parses with its props', (kind) => {
    const samples: { [K in Kind]: Extract<Node, { kind: K }> } = {
      Island: { kind: 'Island', props: {}, children: [] },
      Stack: {
        kind: 'Stack',
        props: {
          direction: 'column',
          gap: 3,
          sizes: ['auto', { flex: 1 }, { fixed: 31 }],
          align: 'stretch',
          pad: [0, 8, 8, 8],
        },
        children: [],
      },
      ToolWindowHeader: {
        kind: 'ToolWindowHeader',
        props: {
          title: 'Git',
          count: 2,
          tabs: [{ id: 'log', label: 'Log' }],
          selected: 'log',
          note: 'r reload',
        },
      },
      ListRow: {
        kind: 'ListRow',
        id: 'row',
        props: {
          text: 'a',
          dim: 'b',
          note: 'c',
          icon: 'folder',
          state: 'disabled',
          reason: 'why',
          key: '⏎',
        },
      },
      Badge: { kind: 'Badge', props: { text: '● Running', hue: 'warn' } },
      KeyHint: {
        kind: 'KeyHint',
        props: { keys: '⌘⏎', label: 'more', context: 'footer', dim: true },
      },
      AgentStatus: {
        kind: 'AgentStatus',
        props: {
          state: 'running',
          word: 'Verifying',
          connection: 'Connecting',
          env: 'Local',
          dot: true,
        },
      },
      Empty: {
        kind: 'Empty',
        props: { title: 'No sessions', line: 'abe session launch starts one.' },
      },
      PickLayer: {
        kind: 'PickLayer',
        id: 'pick',
        props: {
          title: 'Command mode',
          filter: 'car',
          rows: [
            { id: 'card list', text: 'card list', dim: 'the cards', note: '<card>' },
            { id: 'card move', text: 'card move', reason: 'not here' },
          ],
          selected: 'card list',
          state: 'error',
          message: 'abe serve is not answering',
          hint: 'Space tick',
        },
      },
      PromptLayer: {
        kind: 'PromptLayer',
        props: { title: 'abe card show <card>', text: '12', hint: 'the card', error: 'needed' },
      },
      ConfirmLayer: {
        kind: 'ConfirmLayer',
        props: {
          question: 'Run abe pr merge o/r#4?',
          details: ['merge a pull request'],
          risky: { label: 'Yes, run it', letter: 'y' },
          no: 'No',
          danger: true,
          focus: 'risky',
        },
      },
      CommentBox: {
        kind: 'CommentBox',
        props: {
          title: 'Comment on #8 Address picker remembers the last one',
          thread: {
            state: 'ready',
            comments: [{ by: 'Abe', when: '2026-10-22', markdown: '**Needs info:** which?' }],
          },
          destination: 'demo-org · Sandbox · #8 · Azure Boards',
          draft: 'The phone wins.\nSay so.',
          placeholder: 'Your answer',
          state: 'failed',
          error: 'Azure answered 403 (auth)',
          hint: '⏎ post',
        },
      },
      LaunchBox: {
        kind: 'LaunchBox',
        props: {
          title: 'Launch #102 Show VAT under the cart total',
          label: 'Notes for the agent (optional)',
          draft: 'use the existing price helper',
          caret: 3,
          along: ['+ standing · write the test first · yours'],
          where: 'Cloud',
          workflows: {
            rows: [
              { kind: 'head', text: 'Repo’s' },
              {
                kind: 'item',
                id: 'quick-fix',
                name: 'Quick fix',
                desc: 'A bug, reproduced first.',
                on: 'type Bug',
                takes: true,
                picked: true,
              },
            ],
            note: 'Preselected: Quick fix takes type Bug. Any other runs this card too.',
          },
          runs: [
            { id: 'local-sandbox', label: 'Local · its card worktree' },
            { id: 'cloud', label: 'A box · your environment' },
          ],
          ran: 'cloud',
          reach: [{ env: 'dev', label: '✓ dev', on: true }],
          count: '1612 / 2000',
          over: false,
          hint: '⏎ Launch',
        },
      },
      CardDialog: {
        kind: 'CardDialog',
        id: 'dialog:4',
        props: {
          kicker: 'User Story',
          card: 4,
          state: 'Active',
          title: 'Cart total includes shipping',
          meta: ['Alex Example', 'cart'],
          sections: [{ title: 'Description', note: 'Why, What, How', markdown: '## Why\n\nIt.' }],
          scroll: 0,
          buttons: [
            { id: 'dialog:menu', label: 'More', keys: '⌘⏎' },
            { id: 'dialog:primary', label: 'Launch agent', keys: '⏎', primary: true, reason: 'no' },
          ],
          sheets: {
            rows: [{ id: 'sheet:4/cart-totals-a1b2c3', title: 'Cart totals', dim: 'v2 · 14:32' }],
            state: 'error',
            message: 'the org store is not answering',
            selected: 'sheet:4/cart-totals-a1b2c3',
            focused: true,
          },
        },
      },
      CardPage: {
        kind: 'CardPage',
        id: 'card-page:4',
        props: {
          kicker: 'User Story',
          card: 4,
          state: 'Active',
          title: 'Cart total includes shipping',
          meta: ['Alex Example', 'cart'],
          sections: [{ title: 'Description', markdown: 'It.' }],
          scroll: 0,
          buttons: [{ id: 'card:comment', label: 'Comment', keys: '⏎', primary: true }],
          heading: 'Card · demo-shop',
          composer: {
            text: 'Looks right',
            caret: 5,
            placeholder: 'Comment on #4…',
            focused: true,
            state: 'failed',
            error: 'the board did not answer',
          },
        },
      },
      Terminal: {
        kind: 'Terminal',
        id: 'chat-terminal',
        props: {
          key: 'chat:4-a1b2:0',
          argv: ['abe', 'session', 'attach', '4-a1b2'],
          cwd: '/tmp',
          env: { LANG: 'en_US.UTF-8' },
          focused: true,
          screenKeys: ['<Esc>'],
          links: [{ pattern: '^\\W*Show (.+?)\\s*$', click: 'show:$1' }],
        },
      },
      BrowserView: {
        kind: 'BrowserView',
        id: 'sheet-view',
        props: {
          key: 'sheet:cart-totals-a1b2c3:yours:v2',
          url: 'http://127.0.0.1:50123/s/9f2c',
          title: 'Sheet',
          sub: 'Cart totals by market',
          address: 'sheet://cart-totals-a1b2c3',
          version: 2,
          badges: ['yours', 'sandboxed', 'no network'],
          action: { keys: '⌘⏎', label: 'Attach to card' },
          focused: true,
        },
      },
      ChatHeader: {
        kind: 'ChatHeader',
        props: {
          title: 'Chat',
          story: { id: '#4', title: 'cart total' },
          env: 'Cloud',
          subagents: 3,
          hide: 'chat:hide',
        },
      },
      BoardHeader: {
        kind: 'BoardHeader',
        props: {
          title: 'Board',
          tabs: [{ id: 'tab:mine', label: 'Mine' }],
          selected: 'tab:mine',
          active: true,
          counts: [{ text: 'Sprint 1 · 3 cards', hue: 'dim' }],
          note: '/cart',
          more: 'Closed 0 ›',
        },
      },
      BoardColumns: {
        kind: 'BoardColumns',
        props: { scroll: { width: 240, offset: 246, view: 486 } },
        children: [],
      },
      BoardColumn: {
        kind: 'BoardColumn',
        props: { name: 'New', count: 0, note: '+1 below', focused: true, empty: 'No stories' },
        children: [],
      },
      BoardCard: {
        kind: 'BoardCard',
        props: {
          card: 4,
          type: 'Bug',
          bug: true,
          initials: 'AE',
          points: '3 pt',
          title: 'Cart total',
          rail: {
            segments: ['done', 'need', 'todo', 'todo', 'todo'],
            stage: 'Build',
            glyph: '◆',
            word: 'Needs you',
            state: 'needs-you',
            time: '2 min',
            box: 'asleep',
          },
          note: { text: 'No session', hue: 'dim' },
          emphasis: 'needs-you',
          theirs: true,
          selection: 'selected',
          tooltip: '#4 Cart total',
        },
      },
      Transcript: {
        kind: 'Transcript',
        props: { reveal: 'turn:1', bottom: 2 },
        children: [],
      },
      Turn: { kind: 'Turn', props: {}, children: [] },
      ChatMessage: {
        kind: 'ChatMessage',
        props: { text: 'Fix the cart total', context: '@api/src/cart.ts#L12-18' },
      },
      ChangesBar: {
        kind: 'ChangesBar',
        props: {
          files: 2,
          added: 4,
          removed: 2,
          where: 'api/',
          actions: [{ id: 'keep', label: 'Keep', tooltip: 'Keep these changes' }],
          kept: true,
        },
      },
      DiffCard: {
        kind: 'DiffCard',
        id: 'diff:cart',
        props: {
          path: 'api/src/cart.ts',
          added: 1,
          removed: 1,
          lines: [
            { kind: 'deleted', number: 17, text: '  a' },
            { kind: 'inserted', number: 17, text: '  b' },
            { kind: 'context', text: '' },
          ],
          note: '⏎ open · u revert',
          folded: false,
          more: { count: 18, id: 'diff:cart:more' },
          selected: true,
          lang: 'typescript',
        },
      },
      StepRow: {
        kind: 'StepRow',
        props: {
          mark: 'bad',
          verb: 'Ran',
          object: 'npm test',
          objectKind: 'command',
          result: '1 failed',
          time: '4 s',
          unfolded: true,
          output: ['FAIL  cart total ignores quantity'],
          selected: true,
        },
      },
      StepsFold: { kind: 'StepsFold', props: { count: 12 } },
      Prose: { kind: 'Prose', props: { markdown: '`cartTotal` added each price once.' } },
      StageDivider: { kind: 'StageDivider', props: { from: 'Build', to: 'Review', at: '12:41' } },
      NewBelow: { kind: 'NewBelow', id: 'new-below', props: { count: 3 } },
      QueuedMessage: {
        kind: 'QueuedMessage',
        props: { text: 'also handle a zero quantity', remove: 'queued:1:remove' },
      },
      SettingsDialog: {
        kind: 'SettingsDialog',
        id: 'settings',
        props: {
          title: 'Settings',
          search: { text: 'box' },
          note: 'Saved Idle stop · ⌘Z undoes',
          noteTone: 'dim',
          focus: 'page',
        },
        children: [],
      },
      SettingsTree: {
        kind: 'SettingsTree',
        props: {
          nodes: [
            {
              id: 'settings:tree:problems',
              label: 'Problems',
              depth: 0,
              count: { text: '· 2', tone: 'warn' },
              separator: true,
            },
            {
              id: 'settings:tree:abe',
              label: 'Abe',
              depth: 0,
              fold: 'open',
              selected: true,
              dim: false,
              modified: true,
            },
          ],
        },
      },
      SettingsPage: {
        kind: 'SettingsPage',
        props: {
          crumbs: ['Abe', 'Agents & models'],
          scope: 'demo-shop',
          reveal: 'g',
        },
        children: [],
      },
      SettingsGroup: {
        kind: 'SettingsGroup',
        props: { caption: 'Models', note: 'a resumed session keeps its own' },
        children: [],
      },
      SettingRow: {
        kind: 'SettingRow',
        id: 'settings:line:1',
        props: {
          label: 'Reader',
          control: {
            kind: 'combo',
            value: 'sonnet',
            open: {
              choices: [
                { id: 'settings:choice:0', text: 'opus' },
                {
                  id: 'settings:choice:1',
                  text: 'haiku',
                  greyed: "not in the repo's allowedModels",
                },
              ],
              cursor: 0,
              filter: '',
            },
          },
          help: 'subagents that only read',
          source: { text: 'built-in', tone: 'dim', lock: false },
          hint: '⏎ change for me · ⌘⏎ propose for the repo',
          focused: true,
          changed: true,
          error: 'refused (invalid-setting)',
          reason: { text: '', error: 'An Override needs its reason' },
        },
      },
      ProblemRow: {
        kind: 'ProblemRow',
        props: {
          text: 'AWS SSO session expired — sign in again',
          where: 'Logins & tools › AWS SSO · sso-session abe',
          way: { label: 'fix…', tone: 'warn' },
          focused: true,
        },
      },
      SettingsNote: { kind: 'SettingsNote', props: { text: 'No other problems' } },
      SettingsEmpty: {
        kind: 'SettingsEmpty',
        props: {
          title: 'abe serve not answering · Settings read when it is back',
          line: 'dim',
          action: { id: 'settings:retry', label: 'Retry' },
        },
      },
      CheckRow: {
        kind: 'CheckRow',
        id: 'settings:line:3',
        props: {
          label: 'AWS SSO',
          value: 'abe',
          check: 'sso-session abe',
          state: { text: '⚠ sign in again', tone: 'warn' },
          way: 'fix…',
          focused: true,
        },
      },
      SettingsFix: {
        kind: 'SettingsFix',
        id: 'settings:fix',
        props: {
          title: 'fix · AWS SSO',
          state: 'queued · ⏎ runs it',
          stateTone: 'dim',
          cwd: 'demo-shop',
          command: '$ aws sso login --sso-session abe',
          note: 'A fix runs below in a real terminal; the row checks again when it ends',
        },
        children: [],
      },
      SettingsPropose: {
        kind: 'SettingsPropose',
        id: 'settings:propose',
        props: {
          title: 'Propose for repo demo-shop',
          label: 'Box size',
          value: { kind: 'pick', from: 'medium', to: 'large' },
          reason: { text: 'We build on large since Sprint 1', error: 'needs its reason' },
          focus: 'reason',
          error: 'refused (gh-failed)',
          busy: false,
          where: 'opens a pull request on this repo · abe.yaml',
          cancel: { id: 'settings:propose:cancel', label: 'Cancel' },
          open: { id: 'settings:propose:open', label: 'Open pull request' },
        },
      },
      Table: {
        kind: 'Table',
        id: 'boxes-table',
        props: {
          columns: [
            { label: 'Box', width: { fixed: 140 } },
            { label: 'Story', width: { flex: 1 } },
            { label: 'Cost', width: { fixed: 90 }, align: 'end' },
          ],
          rows: [
            {
              id: 'box:demo-shop-1',
              cells: [
                { text: 'demo-shop-1', cloud: 'running', tooltip: 'Box demo-shop-1 · running' },
                { accent: '#1', text: 'Show stock on a product card', hue: 'dim' },
                { text: '$0.21', tooltip: 'today since 00:00 · on-demand estimate' },
              ],
              hue: 'bad',
            },
            { id: 'box:2', cells: [{ rail: ['done', 'now', 'todo'], mark: '●', text: 'Build' }] },
            { cells: [{ text: 'Box sessions not read: AWS login expired', hue: 'dim' }] },
          ],
          selected: 'box:demo-shop-1',
          note: 'Boxes not read · EC2 not answering',
          empty: { title: 'No boxes', line: 'a story launched on a box makes one' },
          foot: [{ keys: '⏎', label: 'attach' }],
        },
      },
      ReviewPane: reviewPaneSample(),
      LinkedLayer: {
        kind: 'LinkedLayer',
        id: 'linked',
        props: {
          story: '#2 The cart total ignores quantity',
          keys: '⌃L',
          filter: 'pu',
          rows: [
            {
              id: 'linked:row:run',
              label: 'Run',
              value: [{ text: 'Build ● Running', hue: 'warn' }, { text: ' · 21 min' }],
              rail: ['done', 'now', 'todo', 'todo', 'todo'],
            },
            {
              id: 'linked:row:pr',
              label: 'Pull request',
              value: [{ text: 'none yet' }],
              dim: true,
            },
          ],
          selected: 'linked:row:run',
          hint: '⏎ open · Esc close',
        },
      },
      PipelinesBar: {
        kind: 'PipelinesBar',
        id: 'pipelines-bar',
        props: {
          scopes: [{ id: 'scope:all', label: 'All', tooltip: "The repository's runs" }],
          selected: 'scope:all',
          workflow: { label: 'Workflow: PR checks', on: true },
          count: 'PR checks · 5 runs',
          source: 'o/r · GitHub Actions',
        },
      },
      RunSummary: {
        kind: 'RunSummary',
        id: 'pipelines-summary',
        props: {
          identity: 'PR checks · run #103 · attempt 1',
          state: { glyph: '✗', word: 'Failed', hue: 'bad' },
          title: 'Fix cart rounding',
          meta: 'fix/x · PR #61 · 9003c7e · 08:00 · 7m 00s',
          jobs: [{ mark: '◇', name: 'deploy', duration: '2m 10s', hue: 'warn', prod: true }],
          skipped: 'e2e · Skipped',
          facts: [{ label: 'Evidence', value: 'rounds to two decimals · cart.test.ts:14' }],
          agent: {
            word: 'Running',
            hue: 'warn',
            workspace: '#12 cart total',
            env: 'Local sandbox',
          },
          actions: [{ id: 'act:fix', label: 'Fix with agent…', primary: true }],
        },
      },
      RunHead: {
        kind: 'RunHead',
        id: 'pipelines-head',
        props: {
          crumbs: [{ id: 'crumb:workflow', text: 'PR checks' }, { text: 'Run #103' }],
          title: 'Fix cart rounding',
          state: { glyph: '✗', word: 'Failed', hue: 'bad' },
          meta: 'run #103 · attempt 1',
          actions: [{ id: 'act:rerun', label: 'Rerun', disabled: true }],
        },
      },
      RunGraph: {
        kind: 'RunGraph',
        id: 'pipelines-graph',
        props: {
          jobs: [
            {
              id: 'job:1',
              name: 'e2e (chromium)',
              group: 'e2e',
              state: { glyph: '✓', word: 'Passed', hue: 'good' },
              duration: '22s',
              column: 0,
              row: 0,
            },
          ],
          edges: [['job:1', 'job:2']],
          selected: 'job:1',
          note: 'Some dependency links cannot be drawn for this revision',
          narrow: true,
          legend: [{ glyph: '✓', word: 'Passed', hue: 'good' }],
        },
      },
      JobPanel: {
        kind: 'JobPanel',
        id: 'pipelines-job',
        props: {
          name: 'unit tests',
          state: { glyph: '✗', word: 'Failed', hue: 'bad' },
          words: 'after 2m 10s · job 90033',
          counters: [{ text: '✗ 1 failed', hue: 'bad' }],
          actions: [{ id: 'act:fix', label: 'Fix with agent…', primary: true }],
          steps: [
            {
              state: { glyph: '✗', word: 'Failed', hue: 'bad' },
              name: 'Run npm test',
              duration: '1m 02s',
              current: true,
            },
          ],
          evidenceTitle: 'EVIDENCE · 1',
          evidence: [
            {
              title: 'playwright-trace',
              detail: 'run #103 · attempt 1',
              unavailable: 'expired',
              file: 'src/a.ts:14',
              artifact: true,
            },
          ],
          selected: 0,
        },
      },
      JobLog: {
        kind: 'JobLog',
        id: 'pipelines-log',
        props: {
          title: 'LOG · RUN NPM TEST',
          range: 'lines 1–1 of 1',
          lines: [{ n: 1, time: '08:01:06', text: '##[error]exit 1', error: true, evidence: true }],
        },
      },
      RunBar: {
        kind: 'RunBar',
        id: 'run-bar',
        props: {
          card: '#2',
          title: 'The cart total ignores quantity',
          on: false,
          context: 'demo-shop · Bug run · 19 min so far',
          linked: true,
        },
      },
      RunSteps: {
        kind: 'RunSteps',
        id: 'run-steps',
        props: {
          rows: [
            {
              id: 'review:1',
              mark: { glyph: '●', hue: 'warn' },
              name: 'review',
              outcome: '1 finding',
              back: true,
              dim: false,
              todo: false,
              needsYou: false,
            },
          ],
          selected: 'review:1',
        },
      },
      RunFocus: {
        kind: 'RunFocus',
        id: 'run-focus',
        props: {
          step: 'build:2',
          name: 'build',
          skill: 'implement',
          meta: '09:18 · 3 min · subagent',
          state: { text: '✓ done', hue: 'good' },
          fresh: true,
          round: 'round 2 of 2',
          back: 'sent back from review',
          chat: true,
          carried: {
            head: 'Sent back with · from review · round 1',
            items: ['1. api/src/cart.ts:14 · floats drift → sum in cents'],
          },
          did: 'Summed in cents.',
          pending: false,
          actions: [{ id: 'run:review', label: 'Review changes', primary: true }],
          read: {
            note: 'the card · gets card · diff · findings',
            blocks: [
              {
                title: '',
                boxed: false,
                parts: [{ kind: 'card', ref: 'AB#2 · bug', title: 'Cart total', text: '' }],
              },
              {
                title: 'Decision it took',
                boxed: false,
                parts: [
                  {
                    kind: 'decisions',
                    rows: [{ chose: 'Sum in cents', over: 'floats', why: 'Cents add exactly.' }],
                  },
                ],
              },
            ],
          },
          made: {
            note: '1 writer · 1 commit',
            blocks: [
              {
                title: 'Checks run itself',
                verdict: { text: '✓ green', hue: 'good' },
                boxed: true,
                parts: [{ kind: 'text', text: 'types ✓ · lint ✓', tone: 'dim' }],
              },
              {
                title: 'Files changed · 1',
                boxed: false,
                parts: [
                  {
                    kind: 'files',
                    rows: [
                      { id: 'run:file:build:2:0', path: 'api/src/cart.ts', added: 4, removed: 3 },
                    ],
                  },
                ],
              },
            ],
          },
          details: [
            {
              kind: 'commands',
              id: 'run:detail:build:2:commands',
              label: 'Commands run',
              note: '1',
              open: true,
              rows: [
                { mark: { glyph: '✓', hue: 'good' }, command: 'npm test', result: '19 passed' },
              ],
            },
            {
              kind: 'skills',
              id: 'run:detail:build:2:skills',
              label: 'Skills it pulled in',
              note: '1',
              open: false,
              names: ['tdd'],
            },
          ],
        },
      },
      RunSpecPane: {
        kind: 'RunSpecPane',
        id: 'run-spec',
        props: {
          head: 'Spec #41 on GitHub ↗',
          title: 'Cart total',
          meta: 'Spec · issue #41 · from AB#2',
          body: '## Why\n\nbecause',
          criteria: [{ n: 1, mark: { glyph: '✓', hue: 'good' }, text: 'one', proof: true }],
          page: true,
        },
      },
      QuestionCard: {
        kind: 'QuestionCard',
        id: 'card:q-1',
        props: {
          ask: 'permission',
          title: 'Allow Bash: npm ci?',
          mono: 'npm ci',
          why: 'Reach: writes only in the worktree',
          where: "Local sandbox · the command runs in Claude Code's sandbox",
          options: [
            { n: 1, label: 'Allow once', recommended: true },
            { n: 2, label: 'Open workspace', key: '⌃W', reason: 'not yet' },
          ],
          own: 'Tell it what to do instead…',
          typing: 'use npm install',
          selected: 'own',
          stack: { n: 2, of: 3 },
          under: 1,
          foot: '⏎ answer · Esc back to the options',
          expired: 'Answer in Terminal mode · ⌘4',
          whose: 'waiting on Ada Example',
          more: 'The story says sign in with email.',
          moreOpen: true,
        },
      },
      CardLine: {
        kind: 'CardLine',
        id: 'card:q-1:line',
        props: {
          head: 'Q1',
          text: 'No, static widths',
          n: 2,
          note: '⌘2 shows it',
          waiting: true,
          boxed: true,
          selected: true,
        },
      },
      GrillRound: {
        kind: 'GrillRound',
        id: 'round:q-2',
        props: {
          round: 2,
          questions: 3,
          answered: 1,
          dots: ['done', 'now', 'todo'],
          foot: 'y accepts the recommendation',
          whose: 'waiting on Ada Example',
          stack: { n: 1, of: 2 },
        },
        children: [],
      },
      OverrideCard: {
        kind: 'OverrideCard',
        id: 'override',
        props: {
          title: 'Override · Test DB write',
          line: 'Reach lowered for this session only · tracked on #2 and the PR',
          reason: 'Seed the shop',
          missing: true,
          error: 'writes-only-on-box',
          facts: [{ label: 'Until', text: 'this session ends' }],
          foot: '⏎ override · Esc cancel',
          sending: true,
        },
      },
      DeferredPill: {
        kind: 'DeferredPill',
        id: 'cards:pill',
        props: { count: 1, text: 'Which market table should the cart total read?' },
      },
      Composer: {
        kind: 'Composer',
        id: 'composer:composer',
        props: {
          text: 'Keep the changes',
          placeholder: 'Ask or tell the agent…',
          focused: true,
          model: { label: 'opus', note: 'high · next resume', id: 'composer:model' },
        },
        children: [
          {
            kind: 'ContextChip',
            props: { text: '@api/src/cart.ts:16 · caret line', drop: '⌫ drop' },
          },
        ],
      },
      ContextChip: {
        kind: 'ContextChip',
        id: 'composer:chip',
        props: { text: 'context dropped · ⌫ again brings it back', dropped: true },
      },
      AttachChip: {
        kind: 'AttachChip',
        id: 'composer:detach:0',
        props: { name: 'Screenshot 2026-10-28.png', image: true },
      },
      ChatStatus: {
        kind: 'ChatStatus',
        id: 'chat:status',
        props: {
          tone: 'working',
          words: 'Running bun test',
          since: 1_790_000_000_000,
          agents: { text: '2 subagents', id: 'chat:agents', running: 2, open: true },
          list: [
            {
              id: 'chat:agent:a1',
              name: 'abe:reader',
              task: 'Read the cart',
              state: 'running',
              since: 1_790_000_000_000,
              last: 'Read cart.ts',
            },
          ],
          selected: 0,
        },
      },
      SlashMenu: {
        kind: 'SlashMenu',
        id: 'composer:menu',
        props: {
          items: [
            { id: 'composer:menu:0', cmd: '/compact', desc: 'shorten the conversation' },
            {
              id: 'composer:menu:1',
              cmd: '/improve',
              desc: 'change VimStorm for you',
              reason: 'Improve mode comes with #117',
            },
          ],
          selected: 0,
        },
      },
      LocalBand: {
        kind: 'LocalBand',
        id: 'local-band',
        props: {
          lead: 'Local mode',
          text: 'the board, issues and CI are read from GitHub; writes stay on this machine, agents run here.',
          links: [
            { id: 'local:held', label: '7 held writes' },
            { id: 'local:settings', label: 'Settings' },
          ],
        },
      },
      LocalPullRequest: {
        kind: 'LocalPullRequest',
        id: 'local-pr',
        props: {
          name: '#L3',
          line: 'local · card/1240-checkout-copy → main · not pushed',
          title: 'Checkout copy for Nordic markets',
          about: 'The Factory wrote it here instead of on GitHub.',
          checks: [{ name: 'tests', glyph: '✓', hue: 'good' }],
          body: 'Closes #1240 (would).',
          actions: { focus: 'merge' },
          done: { text: '✓ Merged into main · 3f2a1b9', hue: 'good' },
          note: 'would open on github.com/mkdir-swe/demo-shop',
          away: true,
        },
      },
      InstallParts: {
        kind: 'InstallParts',
        id: 'install-parts',
        props: {
          title: 'Install',
          state: { text: '3 of 7', hue: 'warn' },
          join: { text: 'Join', hue: 'accent' },
          parts: [
            { id: 'install:part:sources', glyph: '○', hue: 'dim', name: 'Sources', open: true },
          ],
          files: { id: 'install:files', text: 'Files 1' },
          unfolded: {
            kind: 'part',
            glyph: '○',
            hue: 'dim',
            name: 'Sources',
            tag: 'optional',
            line: 'Not checked yet',
            actions: [
              { id: 'install:recheck:sources', label: 'Re-check' },
              { id: 'install:again:sources', label: 'Do again' },
            ],
          },
          compact: true,
        },
      },
      PrototypePage: {
        kind: 'PrototypePage',
        id: 'prototype-page',
        props: {
          page: 'preview',
          bar: {
            host: '127.0.0.1:41207',
            path: '/products',
            viewports: [{ id: 'proto:viewport:390', label: '390', on: true }],
            reload: 'proto:reload',
            open: 'proto:open',
            actions: [{ id: 'proto:make-card', label: 'Make card', keys: 'm' }],
          },
          body: { kind: 'live', width: 390, phone: true, keys: false },
        },
        children: [
          {
            kind: 'BrowserView',
            props: {
              key: 'prototype:proto-1a2b3c',
              url: 'http://127.0.0.1:41207/products',
              mode: 'app',
              bare: true,
              reload: 1,
              title: 'Preview',
            },
          },
        ],
      },
    };

    expect(Node.parse(samples[kind])).toEqual(samples[kind]);
  });

  test('a Table refuses no columns, a cell without its row, an unknown width or cloud', () => {
    const table = (props: Record<string, unknown>) =>
      Node.safeParse({
        kind: 'Table',
        props: { columns: [{ label: 'Story', width: { flex: 1 } }], rows: [], ...props },
      }).success;

    expect(table({})).toBe(true);
    expect(table({ columns: [] })).toBe(false);
    expect(table({ columns: [{ label: 'Story', width: 'auto' }] })).toBe(false);
    expect(table({ rows: [{ id: 'r', cells: [] }] })).toBe(false);
    expect(table({ rows: [{ id: 'r', cells: [{ cloud: 'gone' }] }] })).toBe(false);
    expect(table({ rows: [{ id: 'r', cells: [{ rail: ['soon'] }] }] })).toBe(false);
  });

  test("AgentStatus's word is its state's, or a running step's", () => {
    expect(agentStatus('ready').props.word).toBe('Ready for review');
    expect(agentStatus('running', { step: 'Verifying' }).props.word).toBe('Verifying');
    expect(agentStatus('failed', { step: 'Verifying' }).props.word).toBe('Failed');
  });
});

describe("the bridge's frames from the app", () => {
  test.each<[string, string, string]>([
    [
      'another v (an app of v1, whole trees only)',
      '{"v":1,"type":"hello","size":{"width":1,"height":1},"version":"x"}',
      'unsupported-version',
    ],
    ['not JSON', 'hello', 'bad-request'],
    ['no v', '{"type":"hello"}', 'bad-request'],
    ['an unknown type', '{"v":2,"type":"poke"}', 'bad-request'],
  ])('%s is refused %s', (_, line, code) => {
    const read = readAppLine(line);

    expect(read.ok ? 'read' : read.error.code).toBe(code);
  });

  test('a key in nvim notation is an input frame', () => {
    expect(readAppLine('{"v":2,"type":"input","input":{"kind":"key","key":"<CR>"}}')).toEqual({
      ok: true,
      frame: { v: 2, type: 'input', input: { kind: 'key', key: '<CR>' } },
    });
  });
});

describe('the layers', () => {
  test.each<[string, unknown]>([
    [
      'a confirm whose letter is a word',
      {
        kind: 'ConfirmLayer',
        props: { question: 'q', risky: { label: 'Merge', letter: 'merge' } },
      },
    ],
    [
      'a pick row without an id',
      { kind: 'PickLayer', props: { title: 't', rows: [{ text: 'a' }] } },
    ],
    [
      'a prompt with ticks it does not have',
      { kind: 'PromptLayer', props: { title: 't', text: '', ticks: [] } },
    ],
  ])('refuse %s', (_, node) => {
    expect(Node.safeParse(node).success).toBe(false);
  });
});
