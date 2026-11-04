/**
 * Logins & tools (#108 S6, board S-Logins): this Mac's logins and the tools `abe serve` runs, one
 * row each ending in `✓ OK` or `fix… ⏎`, nothing in between. The rows come from `abe login status`
 * and `abe tools check` (run when the page shows, never in the background); a fix is the real
 * command, typed into the fix strip under the page and run only on your ⏎. Then this checkout's
 * sources (`abe source status`, ADR 0028): each one's state, and its Sign in on ⏎, which serve
 * runs in your browser, outside any sandbox (`abe source sign-in`), no fix strip.
 */
import {
  checkedLogins,
  loginFix,
  loginNote,
  LOGINS,
  type LoginStatusData,
  MACHINE_LOGINS,
} from '../../logins/logins';
import { plainText } from '../../factory/ansi';
import { type SourcesData } from '../../install/source-status';
import {
  TOOL_SPECS,
  TOOLS,
  toolProblem,
  toolWords,
  type ToolsCheckData,
} from '../../install/tools';

/** One row of Logins & tools. */
export type CheckItem = {
  /** `login:github`, `tool:node`. */
  id: string;
  group: 'Logins' | 'Sources' | 'Tools';
  label: string;
  /** What the check found (`3.5a`), dim; `null` for none. */
  value: string | null;
  /** The check as it runs: `gh auth status`. */
  check: string;
  ok: boolean;
  /** Not OK and no problem: a tool this Mac can do without (Docker), its row not a warning. */
  optional: boolean;
  /** `✓ OK`, `⚠ sign in again`, `⚠ not found on serve's PATH`, `○ … · optional: …`. */
  state: string;
  /** The fix's command, `null` when OK or none (a box's own tools). */
  fix: string | null;
  /** Its read is under way (#345): `checking…`, no state yet. */
  checking: boolean;
  /**
   * A source's Sign in (ADR 0028), its way on ⏎ in place of a fix: `offered` (it would help),
   * `signing-in` (serve runs it now; ⏎ starts it again); null: none, or not a source.
   */
  signIn?: 'offered' | 'signing-in' | null | undefined;
};

const loginWords = {
  ok: '✓ OK',
  expired: '⚠ sign in again',
  missing: '⚠ not signed in',
  unchecked: "⚠ can't check",
} as const;

/** What a row says while its read is under way (#345). */
export const CHECKING = 'checking…';

/**
 * A row with no answer: its read under way (`checking…`), or refused (`why`: `⚠ can't check: …`),
 * its label and check as the answer's will be.
 */
const unanswered = (
  id: string,
  group: CheckItem['group'],
  label: string,
  check: string,
  why: string | undefined,
): CheckItem => ({
  id,
  group,
  label,
  value: null,
  check,
  ok: false,
  optional: why === undefined,
  state: why === undefined ? CHECKING : `⚠ can't check: ${plainText(why)}`,
  fix: null,
  checking: why === undefined,
});

/**
 * The rows from the two reads (either may be missing: not read yet, or refused). A read under
 * way (`checking`) draws its rows at once as `checking…`, the same rows its answer fills in, so
 * nothing moves as it lands (#345); a refused one (`refused`, why) keeps them, saying so.
 */
export const checkItems = (o: {
  logins?: LoginStatusData | undefined;
  tools?: ToolsCheckData | undefined;
  sources?: SourcesData | undefined;
  checking?:
    | { logins?: boolean | undefined; tools?: boolean | undefined; sources?: boolean | undefined }
    | undefined;
  refused?:
    | { logins?: string | undefined; tools?: string | undefined; sources?: string | undefined }
    | undefined;
  /** `false`: the repo's board is On this machine, so az signs in to nothing it reads: no row. */
  azure?: boolean | undefined;
}): CheckItem[] => [
  ...(o.logins === undefined && (o.checking?.logins === true || o.refused?.logins !== undefined)
    ? MACHINE_LOGINS.filter((tool) => tool !== 'az' || o.azure !== false).map((tool) =>
        unanswered(
          `login:${tool}`,
          'Logins',
          LOGINS[tool].label,
          LOGINS[tool].check,
          o.checking?.logins === true ? undefined : o.refused?.logins,
        ),
      )
    : []),
  ...(o.logins === undefined
    ? []
    : checkedLogins(o.logins)
        .filter((tool) => tool !== 'az' || o.azure !== false)
        .map((tool): CheckItem => {
          const l = LOGINS[tool];
          const state = o.logins?.logins[tool] ?? 'missing';
          const profile = tool === 'aws' ? (o.logins?.awsProfile ?? null) : null;
          const why = o.logins?.unchecked?.[tool];
          const blocked = o.logins?.blocked?.[tool];
          const signs = state !== 'ok' && state !== 'unchecked' && blocked === undefined;
          // az's folder it was checked in, as `abe login status` says it
          const note =
            signs && tool === 'az' && o.logins !== undefined
              ? loginNote(tool, o.logins)
              : undefined;
          const words =
            state !== 'ok' && blocked !== undefined
              ? `⚠ blocked by Entra (${blocked})`
              : `${loginWords[state]}${note === undefined ? '' : `: ${plainText(note)}`}`;

          return {
            id: `login:${tool}`,
            group: 'Logins',
            label: profile === null ? l.label : `${l.label} · ${profile}`,
            // who it is signed in as (#345), while it works
            value: state === 'ok' ? (o.logins?.who?.[tool] ?? null) : null,
            check: l.check,
            ok: state === 'ok',
            optional: false,
            // #160: not checked is no sign-in to fix; the tool's own row has its fix.
            state:
              state === 'unchecked' && why !== undefined
                ? `${loginWords[state]}: ${plainText(why)}`
                : words,
            // #237: no command here gets past Entra's refusal; its words say what does.
            fix:
              state === 'ok' || state === 'unchecked' || blocked !== undefined
                ? null
                : loginFix(tool, o.logins?.secret ?? null, profile, o.logins?.azureConfigDir),
            checking: false,
          };
        })),
  // a source's row, its Sign in serve's (ADR 0028); none to say while unread (unknown ones)
  ...(o.sources === undefined && o.refused?.sources !== undefined
    ? [unanswered('source:', 'Sources', 'Sources', 'abe source status', o.refused.sources)]
    : []),
  ...(o.sources?.sources ?? []).map((x): CheckItem => ({
    id: `source:${x.id}`,
    group: 'Sources',
    label: x.id,
    value: null,
    check: `MCP server ${x.server}`,
    ok: x.reads,
    optional: false,
    state: x.reads ? `✓ ${x.check}` : x.check,
    fix: null,
    checking: false,
    signIn: x.signIn,
  })),
  ...(o.tools === undefined && (o.checking?.tools === true || o.refused?.tools !== undefined)
    ? TOOLS.map((tool) =>
        unanswered(
          `tool:${tool}`,
          'Tools',
          TOOL_SPECS[tool].label,
          TOOL_SPECS[tool].argv.join(' '),
          o.checking?.tools === true ? undefined : o.refused?.tools,
        ),
      )
    : []),
  ...(o.tools?.tools ?? []).map((t): CheckItem => ({
    id: `tool:${t.tool}`,
    group: 'Tools',
    label: t.label,
    // node's version manager (#145): `22.11.0 · Volta`; where it is, after the check.
    value: t.manager === null ? t.version : `${t.version ?? '?'} · ${t.manager}`,
    check: t.manager === null || t.where === null ? t.check : `${t.check} · ${t.where}`,
    ok: t.state === 'ok',
    optional: t.state !== 'ok' && !toolProblem(t),
    state: t.state === 'ok' ? '✓ OK' : plainText(toolWords(t)),
    fix: t.state === 'ok' ? null : t.fix,
    checking: false,
  })),
];
