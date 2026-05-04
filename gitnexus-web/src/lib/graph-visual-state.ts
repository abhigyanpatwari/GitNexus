import { GRAPH_HIGHLIGHT_COLORS, GRAPH_SURFACE_COLORS } from './constants';

export type GraphNodeAnimation = {
  type: 'pulse' | 'ripple' | 'glow';
  startTime: number;
  duration: number;
};

export type ResolvedGraphNodeVisual = {
  color: string;
  size: number;
  zIndex: number;
  highlighted: boolean;
  emphasis: number;
  shell: boolean;
  shellColor: string;
};

export type ResolvedGraphEdgeVisual = {
  color: string;
  size: number;
  zIndex: number;
};

export const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 100, g: 100, b: 100 };
};

export const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((x) => {
      const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
      return hex.length === 1 ? `0${hex}` : hex;
    })
    .join('')}`;

export const dimColor = (hex: string, amount: number): string => {
  const rgb = hexToRgb(hex);
  const darkBg = hexToRgb(GRAPH_SURFACE_COLORS.dimMix);
  return rgbToHex(
    darkBg.r + (rgb.r - darkBg.r) * amount,
    darkBg.g + (rgb.g - darkBg.g) * amount,
    darkBg.b + (rgb.b - darkBg.b) * amount,
  );
};

export const brightenColor = (hex: string, factor: number): string => {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    rgb.r + ((255 - rgb.r) * (factor - 1)) / factor,
    rgb.g + ((255 - rgb.g) * (factor - 1)) / factor,
    rgb.b + ((255 - rgb.b) * (factor - 1)) / factor,
  );
};

export const mixColor = (from: string, to: string, amount: number): string => {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
};

const EMPTY_SET = new Set<string>();
const EMPTY_ANIMATIONS = new Map<string, GraphNodeAnimation>();

const createNodeVisual = (
  color: string,
  size: number,
  options: Partial<Omit<ResolvedGraphNodeVisual, 'color' | 'size'>> = {},
): ResolvedGraphNodeVisual => ({
  color,
  size,
  zIndex: options.zIndex ?? 0,
  highlighted: options.highlighted ?? false,
  emphasis: options.emphasis ?? 0.46,
  shell: options.shell ?? false,
  shellColor: options.shellColor ?? color,
});

export const resolveGraphNodeVisual = ({
  nodeId,
  color,
  size,
  selectedNodeId = null,
  hoveredNodeId = null,
  highlightedNodeIds = EMPTY_SET,
  blastRadiusNodeIds = EMPTY_SET,
  animatedNodes = EMPTY_ANIMATIONS,
  isNeighbor = false,
  now = Date.now(),
}: {
  nodeId: string;
  color: string;
  size: number;
  selectedNodeId?: string | null;
  hoveredNodeId?: string | null;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  animatedNodes?: Map<string, GraphNodeAnimation>;
  isNeighbor?: boolean;
  now?: number;
}): ResolvedGraphNodeVisual => {
  const baseSize = Math.max(0, size || 0);
  const isHovered = nodeId === hoveredNodeId;
  const hoveredScale = isHovered ? 1.22 : 1;
  const animation = animatedNodes.get(nodeId);

  if (animation) {
    const elapsed = now - animation.startTime;
    const progress = Math.min(elapsed / animation.duration, 1);
    const phase = (Math.sin(progress * Math.PI * 4) + 1) / 2;

    if (animation.type === 'pulse') {
      return createNodeVisual(
        phase > 0.5
          ? GRAPH_HIGHLIGHT_COLORS.query
          : brightenColor(GRAPH_HIGHLIGHT_COLORS.query, 1.3),
        baseSize * (1.5 + phase * 0.8),
        {
          zIndex: 5,
          highlighted: true,
          emphasis: 1,
          shell: true,
          shellColor: GRAPH_HIGHLIGHT_COLORS.querySoft,
        },
      );
    }

    if (animation.type === 'ripple') {
      return createNodeVisual(
        phase > 0.5 ? GRAPH_HIGHLIGHT_COLORS.blast : GRAPH_HIGHLIGHT_COLORS.blastPulse,
        baseSize * (1.3 + phase * 1.15),
        {
          zIndex: 5,
          highlighted: true,
          emphasis: 1,
          shell: true,
          shellColor: GRAPH_HIGHLIGHT_COLORS.blastSoft,
        },
      );
    }

    return createNodeVisual(
      phase > 0.5 ? GRAPH_HIGHLIGHT_COLORS.change : GRAPH_HIGHLIGHT_COLORS.changePulse,
      baseSize * (1.35 + phase * 0.6),
      {
        zIndex: 5,
        highlighted: true,
        emphasis: 1,
        shell: true,
        shellColor: GRAPH_HIGHLIGHT_COLORS.changeSoft,
      },
    );
  }

  if (selectedNodeId) {
    if (nodeId === selectedNodeId) {
      const selectedColor = brightenColor(color, 1.25);
      return createNodeVisual(selectedColor, baseSize * 1.85, {
        zIndex: 4,
        highlighted: true,
        emphasis: 1,
        shell: true,
        shellColor: brightenColor(selectedColor, 1.5),
      });
    }

    if (isNeighbor) {
      return createNodeVisual(color, baseSize * 1.25 * hoveredScale, {
        zIndex: 2,
        emphasis: 0.55,
        shell: isHovered,
        shellColor: '#e0f2fe',
      });
    }

    return createNodeVisual(dimColor(color, 0.26), baseSize * 0.6, {
      emphasis: 0.1,
    });
  }

  if (blastRadiusNodeIds.size > 0) {
    if (blastRadiusNodeIds.has(nodeId)) {
      return createNodeVisual(GRAPH_HIGHLIGHT_COLORS.blast, baseSize * 1.8 * hoveredScale, {
        zIndex: 3,
        highlighted: true,
        emphasis: 1,
        shell: true,
        shellColor: GRAPH_HIGHLIGHT_COLORS.blastSoft,
      });
    }

    if (highlightedNodeIds.has(nodeId)) {
      return createNodeVisual(GRAPH_HIGHLIGHT_COLORS.query, baseSize * 1.42 * hoveredScale, {
        zIndex: 2,
        highlighted: true,
        emphasis: 0.82,
        shell: true,
        shellColor: GRAPH_HIGHLIGHT_COLORS.querySoft,
      });
    }

    return createNodeVisual(dimColor(color, 0.18), baseSize * 0.46, {
      emphasis: 0.08,
    });
  }

  if (highlightedNodeIds.size > 0) {
    if (highlightedNodeIds.has(nodeId)) {
      return createNodeVisual(GRAPH_HIGHLIGHT_COLORS.query, baseSize * 1.58 * hoveredScale, {
        zIndex: 2,
        highlighted: true,
        emphasis: 0.9,
        shell: true,
        shellColor: GRAPH_HIGHLIGHT_COLORS.querySoft,
      });
    }

    return createNodeVisual(dimColor(color, 0.22), baseSize * 0.52, {
      emphasis: 0.1,
    });
  }

  if (isHovered) {
    return createNodeVisual(mixColor(brightenColor(color, 1.25), '#ffffff', 0.08), baseSize * 1.24, {
      zIndex: 1,
      emphasis: 0.82,
      shell: true,
      shellColor: '#e0f2fe',
    });
  }

  return createNodeVisual(color, baseSize);
};

export const resolveGraphEdgeVisual = ({
  sourceId,
  targetId,
  color,
  size,
  selectedNodeId = null,
  highlightedNodeIds = EMPTY_SET,
  blastRadiusNodeIds = EMPTY_SET,
}: {
  sourceId: string;
  targetId: string;
  color: string;
  size: number;
  selectedNodeId?: string | null;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
}): ResolvedGraphEdgeVisual => {
  const baseSize = size || 1;

  if (selectedNodeId) {
    const isConnected = sourceId === selectedNodeId || targetId === selectedNodeId;
    return isConnected
      ? {
          color: brightenColor(color, 1.5),
          size: Math.max(3, baseSize * 4),
          zIndex: 2,
        }
      : {
          color: dimColor(color, 0.1),
          size: 0.3,
          zIndex: 0,
        };
  }

  if (highlightedNodeIds.size > 0 || blastRadiusNodeIds.size > 0) {
    const sourceActive = highlightedNodeIds.has(sourceId) || blastRadiusNodeIds.has(sourceId);
    const targetActive = highlightedNodeIds.has(targetId) || blastRadiusNodeIds.has(targetId);

    if (sourceActive && targetActive) {
      return {
        color:
          blastRadiusNodeIds.has(sourceId) && blastRadiusNodeIds.has(targetId)
            ? GRAPH_HIGHLIGHT_COLORS.blast
            : GRAPH_HIGHLIGHT_COLORS.query,
        size: Math.max(2, baseSize * 3),
        zIndex: 2,
      };
    }

    if (sourceActive || targetActive) {
      return {
        color: dimColor(GRAPH_HIGHLIGHT_COLORS.query, 0.4),
        size: 1,
        zIndex: 1,
      };
    }

    return {
      color: dimColor(color, 0.08),
      size: 0.2,
      zIndex: 0,
    };
  }

  return {
    color,
    size: baseSize,
    zIndex: 0,
  };
};
