import { describe, it, expect } from 'vitest';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';

describe('GDScript language registration', () => {
  it('maps .gd files to the godot language', () => {
    expect(getLanguageFromFilename('res://player.gd')).toBe('godot');
  });

  it('exposes Godot in SupportedLanguages', () => {
    expect(Object.values(SupportedLanguages)).toContain('godot');
  });

  it('returns a provider with id godot for .gd files', () => {
    const provider = getProviderForFile('res://player.gd');
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('godot');
  });

  it('declares .gd in the provider extensions', () => {
    const provider = getProviderForFile('foo.gd');
    expect(provider?.extensions).toContain('.gd');
  });
});
