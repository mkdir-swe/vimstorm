import { describe, expect, test } from 'bun:test';
import { isExCommand } from './ex';

/** A few of the names Neovim's `getcompletion('', 'command')` gives, a user's two among them. */
const KNOWN = [
  'append',
  'insert',
  'change',
  'make',
  'help',
  'write',
  'wq',
  'quit',
  'qall',
  'substitute',
  'set',
  'delete',
  'global',
  'move',
  'new',
  'edit',
  'Lazy',
  'LspInfo',
  'LspRestart',
];

describe('isExCommand: what Run in Neovim takes (#346)', () => {
  test.each([
    ['w', true],
    ['wq', true],
    [':w', true],
    ['q', true],
    ['%s/a/b/g', true],
    ["'<,'>d", true],
    ['42', true],
    ['$', true],
    ['.,+3d', true],
    ['!ls', true],
    ['g/x/d', true],
    ['e src/cart.ts', true],
    ['Lazy', true],
    ['LspI', true],
    ['Lsp', false],
    ['look', false],
    ['status', false],
    ['car', false],
    ['why does the cart total ignore quantity', false],
    // sentences that start with an Ex name are sentences (`:make`, `:help`, `:delete`, `:append`)
    ['make this faster', false],
    ['help me read this', false],
    ['delete the unused import', false],
    ['a question', false],
    // an apostrophe or a per cent is a sentence's, not Ex's
    ["let's add a test for the cart", false],
    ["i don't get this", false],
    ["delete the user's old import", false],
    ['make it 50% faster', false],
    ['w!', true],
    ['i see', false],
    // a command and its one argument, or Ex's signs, still are
    ['set number', true],
    ['s/a b/c d/', true],
    ['w !sudo tee %', true],
    ['', false],
    ['   ', false],
  ])('%p → %p', (text, ex) => {
    expect(isExCommand(text, KNOWN)).toBe(ex);
  });
});
