import { describe, expect, it } from 'vitest';
import { parseRenamePrompt, pickPrimarySymbol, resolveWorkflow } from '../src/chat/parser';

describe('resolveWorkflow', () => {
  it('prefers explicit slash command when provided', () => {
    expect(resolveWorkflow('impact', 'explore this')).toBe('impact');
  });

  it('infers workflow from prompt hints', () => {
    expect(resolveWorkflow(undefined, 'please debug this exception')).toBe('debug');
    expect(resolveWorkflow(undefined, 'show blast radius for parseUser')).toBe('impact');
    expect(resolveWorkflow(undefined, 'rename parseUser to parseAccount')).toBe('refactor');
    expect(resolveWorkflow(undefined, 'trace execution flow')).toBe('flow');
    expect(resolveWorkflow(undefined, 'what did my staged changes affect')).toBe('changes');
  });

  it('defaults to explore', () => {
    expect(resolveWorkflow(undefined, 'tell me about auth')).toBe('explore');
  });
});

describe('parseRenamePrompt', () => {
  it('parses natural-language rename prompt', () => {
    expect(parseRenamePrompt('rename oldName to newName')).toEqual({
      source: 'oldName',
      target: 'newName',
    });
  });

  it('parses arrow rename syntax', () => {
    expect(parseRenamePrompt('oldName -> newName')).toEqual({
      source: 'oldName',
      target: 'newName',
    });
  });

  it('returns undefined for unrelated text', () => {
    expect(parseRenamePrompt('please help me refactor')).toBeUndefined();
  });
});

describe('pickPrimarySymbol', () => {
  it('picks first token as symbol', () => {
    expect(pickPrimarySymbol('AuthService downstream callers')).toBe('AuthService');
  });

  it('returns undefined for empty prompts', () => {
    expect(pickPrimarySymbol('   ')).toBeUndefined();
  });
});
