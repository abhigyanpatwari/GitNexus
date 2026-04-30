declare module 'd3-force-3d' {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<NodeDatum extends SimulationNodeDatum> {
    source: string | number | NodeDatum;
    target: string | number | NodeDatum;
    index?: number;
  }

  export interface Force<NodeDatum extends SimulationNodeDatum> {
    (alpha: number): void;
    initialize?: (nodes: NodeDatum[], random: () => number, dimensions: number) => void;
  }

  export interface Simulation<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > {
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
    numDimensions(): number;
    numDimensions(dimensions: number): this;
    nodes(): NodeDatum[];
    nodes(nodes: NodeDatum[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(alpha: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(alpha: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    force(name: string): Force<NodeDatum> | undefined;
    force(name: string, force: Force<NodeDatum> | null): this;
    find(x?: number, y?: number, z?: number, radius?: number): NodeDatum | undefined;
    on(typenames: 'tick' | 'end', listener: ((this: this) => void) | null): this;
  }

  export interface ForceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > extends Force<NodeDatum> {
    links(): LinkDatum[];
    links(links: LinkDatum[]): this;
    id(): (node: NodeDatum, index: number, nodes: NodeDatum[]) => string | number;
    id(id: (node: NodeDatum, index: number, nodes: NodeDatum[]) => string | number): this;
    distance(): (link: LinkDatum, index: number, links: LinkDatum[]) => number;
    distance(distance: number | ((link: LinkDatum, index: number, links: LinkDatum[]) => number)): this;
    strength(): (link: LinkDatum, index: number, links: LinkDatum[]) => number;
    strength(strength: number | ((link: LinkDatum, index: number, links: LinkDatum[]) => number)): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export interface ForceManyBody<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum> {
    strength(): (node: NodeDatum, index: number, nodes: NodeDatum[]) => number;
    strength(strength: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this;
    theta(): number;
    theta(theta: number): this;
  }

  export interface ForceCollide<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum> {
    radius(): (node: NodeDatum, index: number, nodes: NodeDatum[]) => number;
    radius(radius: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this;
    strength(): number;
    strength(strength: number): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export interface ForcePosition<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum> {
    strength(): (node: NodeDatum, index: number, nodes: NodeDatum[]) => number;
    strength(strength: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this;
  }

  export function forceSimulation<NodeDatum extends SimulationNodeDatum>(
    nodes?: NodeDatum[],
    dimensions?: number,
  ): Simulation<NodeDatum, SimulationLinkDatum<NodeDatum>>;

  export function forceCenter<NodeDatum extends SimulationNodeDatum>(
    x?: number,
    y?: number,
    z?: number,
  ): Force<NodeDatum>;

  export function forceManyBody<NodeDatum extends SimulationNodeDatum>(): ForceManyBody<NodeDatum>;

  export function forceCollide<NodeDatum extends SimulationNodeDatum>(
    radius?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForceCollide<NodeDatum>;

  export function forceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  >(links?: LinkDatum[]): ForceLink<NodeDatum, LinkDatum>;

  export function forceX<NodeDatum extends SimulationNodeDatum>(
    x?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForcePosition<NodeDatum>;

  export function forceY<NodeDatum extends SimulationNodeDatum>(
    y?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForcePosition<NodeDatum>;

  export function forceZ<NodeDatum extends SimulationNodeDatum>(
    z?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForcePosition<NodeDatum>;
}
