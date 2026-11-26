// A tuple directory and an N-API symbol alone also accept the broken upstream
// x86-64 binaries. Require an ELF64 little-endian shared object for the
// expected machine (EM_AARCH64 = 183, EM_X86_64 = 62).
function isNapiSharedObject(bytes, machine) {
  return (
    bytes.length >= 64 &&
    bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    bytes.readUInt16LE(16) === 3 &&
    bytes.readUInt16LE(18) === machine &&
    bytes.includes('napi_register_module_v1')
  );
}

const isArm64NapiSharedObject = (bytes) => isNapiSharedObject(bytes, 183);
const isX64NapiSharedObject = (bytes) => isNapiSharedObject(bytes, 62);

module.exports = { isArm64NapiSharedObject, isX64NapiSharedObject };
