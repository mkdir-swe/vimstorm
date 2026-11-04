/** The theme's rows of the command table: `abe theme`. */
import { command } from '../command';
import {
  Look,
  ThemeListData,
  ThemeSaveData,
  ThemeShowData,
  lookText,
  themeListText,
  themeSaveText,
  themeShowText,
} from './theme';

export const THEME_COMMANDS = {
  'theme list': command({
    noun: 'theme',
    verb: 'list',
    summary: 'the themes: the built-in ones and yours (<config>/themes), the current one marked',
    inSession: true,
    args: {},
    result: ThemeListData,
    text: themeListText,
  }),
  'theme show': command({
    noun: 'theme',
    verb: 'show',
    summary: "a theme's every colour token by group, the changed ones with their base's colour",
    inSession: true,
    args: {
      theme: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the theme, by its slug (islands-dark) or its name as theme list shows it',
      },
    },
    result: ThemeShowData,
    text: themeShowText,
  }),
  'theme look': command({
    noun: 'theme',
    verb: 'look',
    summary:
      "what the window draws with: the theme's tokens, the density and the fonts in force here, a staged change over them",
    inSession: true,
    args: {
      stage: {
        kind: 'flag',
        type: 'string',
        summary: 'a change not written yet, as JSON: {theme?, density?, font?, tokens?}',
      },
    },
    result: Look,
    text: lookText,
  }),
  'theme save': command({
    noun: 'theme',
    verb: 'save',
    summary:
      'save colours changed over a theme to a theme file of yours (a built-in one is never written: it saves <Base> (yours))',
    inSession: false,
    args: {
      theme: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the theme the colours change: its slug (islands-dark) or its name',
      },
      tokens: {
        kind: 'flag',
        type: 'string',
        summary:
          'the changed colours as JSON: {"abe-needs-you": "#a979f7"}; one back at the base drops it',
      },
      name: {
        kind: 'flag',
        type: 'string',
        summary: "the new theme's name (default: <Name> (yours))",
      },
      replace: {
        kind: 'flag',
        type: 'boolean',
        summary: 'write over another theme of yours at that name (else it is refused)',
      },
    },
    result: ThemeSaveData,
    text: themeSaveText,
  }),
};
