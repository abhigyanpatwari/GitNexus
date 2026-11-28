import type { OtherOwner, Wrapper } from './owners.js';

export function fromAlias(wrapper: Wrapper) {
  const x = wrapper.owner;
  return x.artifactIdentity;
}

export function fromChain(wrapper: Wrapper) {
  return wrapper.owner.artifactIdentity;
}

export function fromOther(other: OtherOwner) {
  return other.artifactIdentity;
}
