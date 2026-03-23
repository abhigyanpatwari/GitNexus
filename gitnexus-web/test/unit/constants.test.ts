import { describe, expect, it } from 'vitest';
import {
  NODE_COLORS,
  NODE_SIZES,
  COMMUNITY_COLORS,
  getCommunityColor,
  DEFAULT_VISIBLE_LABELS,
  FILTERABLE_LABELS,
  ALL_EDGE_TYPES,
  DEFAULT_VISIBLE_EDGES,
  EDGE_INFO,
} from '../../src/lib/constants';

describe('NODE_COLORS', () => {
  it('has a color for every node label used in NODE_SIZES', () => {
    for (const label of Object.keys(NODE_SIZES)) {
      expect(NODE_COLORS).toHaveProperty(label);
      expect(NODE_COLORS[label as keyof typeof NODE_COLORS]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('NODE_SIZES', () => {
  it('gives Project the largest size', () => {
    const maxLabel = Object.entries(NODE_SIZES).reduce((a, b) => a[1] > b[1] ? a : b);
    expect(maxLabel[0]).toBe('Project');
  });

  it('gives structural nodes larger sizes than code nodes', () => {
    expect(NODE_SIZES.Folder).toBeGreaterThan(NODE_SIZES.Function);
    expect(NODE_SIZES.File).toBeGreaterThan(NODE_SIZES.Variable);
  });
});

describe('getCommunityColor', () => {
  it('returns valid hex colors', () => {
    for (let i = 0; i < 20; i++) {
      expect(getCommunityColor(i)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('wraps around the palette', () => {
    const paletteSize = COMMUNITY_COLORS.length;
    expect(getCommunityColor(0)).toBe(getCommunityColor(paletteSize));
    expect(getCommunityColor(1)).toBe(getCommunityColor(paletteSize + 1));
  });
});

describe('DEFAULT_VISIBLE_LABELS', () => {
  it('includes common structural and code labels', () => {
    expect(DEFAULT_VISIBLE_LABELS).toContain('File');
    expect(DEFAULT_VISIBLE_LABELS).toContain('Function');
    expect(DEFAULT_VISIBLE_LABELS).toContain('Class');
  });

  it('excludes noisy labels by default', () => {
    expect(DEFAULT_VISIBLE_LABELS).not.toContain('Variable');
    expect(DEFAULT_VISIBLE_LABELS).not.toContain('Import');
  });
});

describe('edge types', () => {
  it('ALL_EDGE_TYPES contains all EDGE_INFO keys', () => {
    const edgeInfoKeys = Object.keys(EDGE_INFO).sort();
    const allEdgeTypes = [...ALL_EDGE_TYPES].sort();
    expect(edgeInfoKeys).toEqual(allEdgeTypes);
  });

  it('DEFAULT_VISIBLE_EDGES is a subset of ALL_EDGE_TYPES', () => {
    for (const type of DEFAULT_VISIBLE_EDGES) {
      expect(ALL_EDGE_TYPES).toContain(type);
    }
  });

  it('EDGE_INFO entries have color and label', () => {
    for (const info of Object.values(EDGE_INFO)) {
      expect(info.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(info.label.length).toBeGreaterThan(0);
    }
  });
});
