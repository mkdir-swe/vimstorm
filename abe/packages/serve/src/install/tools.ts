/**
 * `abe tools check`: each tool Abe runs, checked as this `serve` finds it on its own PATH
 * (`ToolProbe`), never the caller's shell. The rules (which tools, their checks, versions, fixes)
 * are `core/src/install/tools.ts`'.
 */
import {
  boardOf,
  claudeCheck,
  isCloudTarget,
  isGithubBoard,
  isLocalBoard,
  refused,
  toolCheck,
  type ToolCheck,
  type ToolProbe,
  TOOL_SPECS,
  TOOLS,
  type ToolName,
  type ToolsCheckData,
  type Handlers,
} from '@abe/core';
import { type SettingsService } from '../layer';

/**
 * What a handler holds: the probe (none: refused), whether this serve is a box's, and the
 * settings in force where it was asked (which of the tools only some setups need it needs).
 */
export type ToolsCtx = {
  cwd: string;
  settings: SettingsService | undefined;
  serve: {
    toolProbe: ToolProbe | undefined;
    onBox: boolean;
  };
};

/**
 * The tools only some setups need that `dir`'s does (ADR 0042): az for an Azure Boards board,
 * aws for `serve.target: cloud`.
 */
export const toolsNeededIn = (
  settings: SettingsService | undefined,
  dir: string,
): readonly ToolName[] => {
  if (settings === undefined) return [];
  const values = settings.at(dir).values;
  const board = boardOf(values.board);

  return [
    // only an Azure board is read with az
    ...(board.ok && !isLocalBoard(board.board) && !isGithubBoard(board.board)
      ? (['az'] as const)
      : []),
    ...(isCloudTarget(values['serve.target']) ? (['aws'] as const) : []),
  ];
};

/** Every tool checked at once, in `TOOLS` order; `needed`: the ones only some setups need. */
export const checkTools = async (
  probe: ToolProbe,
  onBox: boolean,
  needed: readonly ToolName[] = [],
): Promise<ToolsCheckData> => {
  const managers = await probe.managers();

  return {
    where: onBox ? 'this box' : 'this Mac',
    tools: await Promise.all(
      TOOLS.map(async (tool): Promise<ToolCheck> =>
        // claude: every copy on PATH, the one sessions run named.
        tool === 'claude'
          ? claudeCheck(await probe.runEach(TOOL_SPECS[tool].argv), onBox)
          : toolCheck(tool, await probe.run(TOOL_SPECS[tool].argv), onBox, managers, needed),
      ),
    ),
  };
};

export const toolsHandlers = () =>
  ({
    'tools check': async (_, ctx) =>
      ctx.serve.toolProbe === undefined
        ? refused('no-tool-probe', 'this abe serve was started without its tool checks')
        : {
            ok: true,
            data: await checkTools(
              ctx.serve.toolProbe,
              ctx.serve.onBox,
              toolsNeededIn(ctx.settings, ctx.cwd),
            ),
          },
  }) satisfies Partial<Handlers<ToolsCtx>>;
