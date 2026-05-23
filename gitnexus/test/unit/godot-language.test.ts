import { describe, it, expect } from 'vitest';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { GDSCRIPT_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';

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

const GDSCRIPT_FIXTURE = `class_name Player
extends Node2D

signal died(score: int)

var health: int = 100
static var max_health: int = 100

func _ready():
    print("ready")
    take_damage(10)

func take_damage(amount: int) -> void:
    health -= amount
    if health <= 0:
        died.emit(0)
`;

describe('GDScript tree-sitter queries', () => {
  it('parses GDScript and extracts class, function, variable, heritage, and call captures', async () => {
    const Parser = (await import('tree-sitter')).default;
    const parser = await loadParser();
    await loadLanguage(SupportedLanguages.Godot);
    const tree = parser.parse(GDSCRIPT_FIXTURE);
    const language = parser.getLanguage();
    const query = new (Parser as unknown as { Query: new (lang: unknown, src: string) => unknown }).Query(
      language,
      GDSCRIPT_QUERIES,
    );
    const captures = (query as { captures: (n: unknown) => Array<{ name: string; node: { text: string } }> }).captures(
      tree.rootNode,
    );

    const named = (captureName: string): string[] =>
      captures.filter((c) => c.name === captureName).map((c) => c.node.text);

    expect(named('name')).toEqual(
      expect.arrayContaining(['Player', '_ready', 'take_damage', 'health', 'max_health', 'died']),
    );
    expect(named('heritage.extends')).toEqual(expect.arrayContaining(['Node2D']));
    expect(named('call.name')).toEqual(expect.arrayContaining(['print', 'take_damage', 'emit']));

    const definitionTypes = new Set(captures.filter((c) => c.name.startsWith('definition.')).map((c) => c.name));
    expect(definitionTypes).toEqual(
      new Set(['definition.class', 'definition.function', 'definition.method', 'definition.variable']),
    );
  });
});
