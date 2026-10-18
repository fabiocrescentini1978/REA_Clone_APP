import type * as t from "@babel/types";

/** A canonical shared object is a heap owner, never an intrinsic read proof. */
export interface SemanticSharedStorageIdentity {
  readonly kind: "shared-storage";
  readonly path: readonly string[];
}

export const isSemanticSharedStorageIdentity = (
  identity: object,
): identity is SemanticSharedStorageIdentity =>
  "kind" in identity && identity.kind === "shared-storage";

/** CommonJS nominal storage currently owns aliases, not descriptor facts. */
export const semanticSharedStorageHasDescriptorFacts = (
  path: readonly unknown[],
): boolean => path[0] === "global";

/** One analysis interns shared owners across all provisional/refined queries. */
export const createSemanticSharedStorageIdentities = () => {
  const identities = new Map<string, SemanticSharedStorageIdentity>();
  return (path: readonly string[]): SemanticSharedStorageIdentity => {
    const key = JSON.stringify(path);
    let identity = identities.get(key);
    if (identity === undefined) {
      identity = { kind: "shared-storage", path };
      identities.set(key, identity);
    }
    return identity;
  };
};

/** An allocation is a heap owner even when its expression returns another object. */
export interface SemanticAllocatedReceiverIdentity {
  readonly kind: "allocated-receiver";
  readonly allocation: t.Node;
}
export type SemanticLocalIdentity = t.Node | SemanticAllocatedReceiverIdentity;
export type SemanticStorageIdentity =
  | SemanticLocalIdentity
  | SemanticSharedStorageIdentity;
export const isSemanticAllocatedReceiverIdentity = (
  identity: object,
): identity is SemanticAllocatedReceiverIdentity =>
  "kind" in identity && identity.kind === "allocated-receiver";
const allocationIdentities = new WeakMap<
  t.Node,
  SemanticAllocatedReceiverIdentity
>();
export const semanticAllocatedReceiverIdentity = (
  allocation: t.Node,
): SemanticAllocatedReceiverIdentity => {
  let identity = allocationIdentities.get(allocation);
  if (identity === undefined) {
    identity = { kind: "allocated-receiver", allocation };
    allocationIdentities.set(allocation, identity);
  }
  return identity;
};
