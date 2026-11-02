// A tuple directory and an N-API symbol alone also accept the broken upstream
// x86-64 binaries. Require an ELF64 little-endian AArch64 shared object.
function isArm64NapiSharedObject(bytes) {
  return (
    bytes.length >= 64 &&
    bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(16) === 3 &&
    bytes.readUInt16LE(18) === 183 &&
    bytes.includes('napi_register_module_v1')
  );
}

module.exports = { isArm64NapiSharedObject };
