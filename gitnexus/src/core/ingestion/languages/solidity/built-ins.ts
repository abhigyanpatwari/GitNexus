/** Solidity built-in globals filtered from the call graph. */
export const SOLIDITY_BUILT_INS: ReadonlySet<string> = new Set([
  'require',
  'assert',
  'revert',
  'keccak256',
  'sha256',
  'ripemd160',
  'ecrecover',
  'addmod',
  'mulmod',
  'blockhash',
  'blobhash',
  'gasleft',
  'selfdestruct',
  'suicide',
]);

/**
 * Member-call receivers that are language / Foundry globals — suppress
 * CALLS edges so test harness noise (`vm.prank`, `msg.sender` reads as
 * calls) does not dominate processes. Capture-time filter (builtInNames
 * only gates the *callee* simple name).
 */
export const SOLIDITY_BUILTIN_RECEIVERS: ReadonlySet<string> = new Set([
  'vm',
  'msg',
  'block',
  'tx',
  'abi',
  'type',
]);
