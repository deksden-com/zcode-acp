/** Semantic retries belong to the managed controller, not both sides of ACP. */
export const MANAGED_RECOVERY = "dd-flow/managed-provider-recovery@1";
export const managedRecoveryCapability = { schema_id: MANAGED_RECOVERY, owner: "controller" };

export function managedRecovery(value: unknown): Record<string, string> | undefined {
  const meta = value as { zcode?: { ddFlowRecovery?: Record<string, unknown> } } | undefined;
  const request = meta?.zcode?.ddFlowRecovery;
  if (request === undefined) return undefined;
  if (
    request.schema_id !== MANAGED_RECOVERY ||
    request.owner !== "controller" ||
    ![request.operation_id, request.root_operation_id].every(
      (id) => typeof id === "string" && /^[\w:./-]{1,240}$/.test(id),
    )
  ) {
    throw new Error("Invalid managed recovery contract");
  }
  return {
    ...managedRecoveryCapability,
    operation_id: request.operation_id as string,
    root_operation_id: request.root_operation_id as string,
  };
}
