import { UserRole } from "@prisma/client";

export type Permission =
  | "READ_FINANCIALS"
  | "MANAGE_IMPORTS"
  | "MANAGE_MAPPINGS"
  | "MANAGE_RATE_CARDS"
  | "RUN_RECONCILIATION"
  | "REVIEW_CLAIMS";

const rolePermissions: Record<UserRole, ReadonlySet<Permission>> = {
  FINANCE_EXECUTIVE: new Set([
    "READ_FINANCIALS",
    "MANAGE_IMPORTS",
    "MANAGE_MAPPINGS",
    "MANAGE_RATE_CARDS",
    "RUN_RECONCILIATION",
    "REVIEW_CLAIMS",
  ]),
  CO_FOUNDER: new Set(["READ_FINANCIALS"]),
};

export function hasPermission(
  role: UserRole,
  permission: Permission,
): boolean {
  return rolePermissions[role].has(permission);
}
