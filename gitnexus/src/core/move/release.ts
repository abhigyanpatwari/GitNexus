export const MOVE_FLOW_RELEASE = {
  version: '2.0.0',
  repository: 'aptos-labs/aptos-ai',
  tagPrefix: 'move-flow-v',
} as const;

const COMPATIBLE_MAJOR = Number(MOVE_FLOW_RELEASE.version.split('.')[0]);

export const isCompatibleMoveFlowVersion = (version: string): boolean => {
  const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  return match !== null && Number(match[1]) === COMPATIBLE_MAJOR;
};
