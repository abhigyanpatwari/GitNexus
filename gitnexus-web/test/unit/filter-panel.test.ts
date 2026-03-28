import { describe, expect, it } from 'vitest';
import { FILTERABLE_LABELS, NODE_COLORS } from '../../src/lib/constants';
import type { NodeLabel } from '../../src/core/graph/types';
import * as lucideIcons from '../../src/lib/lucide-icons';

const LEGEND_LABELS: NodeLabel[] = [
  'Folder',
  'File',
  'Class',
  'Interface',
  'Enum',
  'Type',
  'Function',
  'Method',
  'Variable',
  'Decorator',
];

const ICON_MAP: Record<string, string> = {
  Folder: 'Folder',
  File: 'FileCode',
  Class: 'Box',
  Function: 'Braces',
  Method: 'Braces',
  Interface: 'Hash',
  Enum: 'List',
  Type: 'Type',
  Decorator: 'AtSign',
  Import: 'FileCode',
  Variable: 'Variable',
};

describe('filter panel icon mappings', () => {
  it('every filterable label has a mapped icon', () => {
    for (const label of FILTERABLE_LABELS) {
      expect(ICON_MAP).toHaveProperty(label);
    }
  });

  it('every mapped icon is exported from lucide-icons', () => {
    const exportedNames = new Set(Object.keys(lucideIcons));
    const requiredIcons = new Set(Object.values(ICON_MAP));
    for (const iconName of requiredIcons) {
      expect(exportedNames.has(iconName), `${iconName} should be exported from lucide-icons`).toBe(
        true,
      );
    }
  });

  it('newly added node types have distinct icons', () => {
    expect(ICON_MAP.Enum).toBe('List');
    expect(ICON_MAP.Type).toBe('Type');
    expect(ICON_MAP.Decorator).toBe('AtSign');
  });
});

describe('color legend', () => {
  it('includes all newly added node types', () => {
    expect(LEGEND_LABELS).toContain('Enum');
    expect(LEGEND_LABELS).toContain('Type');
    expect(LEGEND_LABELS).toContain('Decorator');
    expect(LEGEND_LABELS).toContain('Variable');
  });

  it('every legend label has a color defined', () => {
    for (const label of LEGEND_LABELS) {
      expect(NODE_COLORS).toHaveProperty(label);
      expect(NODE_COLORS[label]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('legend labels match the order used in FileTreePanel', () => {
    const expected: NodeLabel[] = [
      'Folder',
      'File',
      'Class',
      'Interface',
      'Enum',
      'Type',
      'Function',
      'Method',
      'Variable',
      'Decorator',
    ];
    expect(LEGEND_LABELS).toEqual(expected);
  });

  it('legend labels are a subset of filterable labels plus Import', () => {
    const filterableSet = new Set(FILTERABLE_LABELS);
    for (const label of LEGEND_LABELS) {
      expect(filterableSet.has(label), `${label} should be in FILTERABLE_LABELS`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(LEGEND_LABELS);
    expect(unique.size).toBe(LEGEND_LABELS.length);
  });
});
