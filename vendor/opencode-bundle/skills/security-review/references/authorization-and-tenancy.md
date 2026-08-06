# Authorization and Tenant Isolation

Use for object access, roles, permissions, ownership, tenant scoping, admin operations, policy engines, and service-to-service authorization.

## Security Property

For every effect, verify that the authenticated actor is permitted to perform the specific action on the specific resource in the current tenant/context.

Authentication alone is never proof of authorization.

## Authorization Decision Model

Trace:

`subject -> action -> resource -> context/tenant -> policy -> effect`

Identify where each input originates and whether the policy uses the same resource and tenant that the effect later mutates or returns.

## High-Risk Patterns

### Missing Object-Level Authorization

A global lookup by attacker-selected identifier is followed by read/write/delete without ownership, relationship, or tenant policy.

Safer shapes include scoping the data query to the authorized principal/tenant or applying a centralized object policy before the effect.

### Horizontal and Cross-Tenant Escalation

Check whether one ordinary user can access another user's or tenant's objects by changing:

- path/query/body identifiers;
- nested parent identifiers;
- organization/project/workspace context;
- export, search, batch, attachment, or audit endpoints;
- indirect references in jobs, webhooks, or caches.

A UUID or opaque identifier is not an authorization control.

### Vertical Escalation

Look for:

- admin handlers lacking server-side role/capability checks;
- user-editable role, permission, owner, tenant, or approval fields;
- inconsistent policy between create/read/update/delete/bulk paths;
- privileged helper made callable by lower-privileged paths;
- permission checks against client-supplied identity or role.

### Mass Assignment and Over-Posting

Trace generic object update/create operations. Verify security-sensitive fields are excluded or independently authorized, including:

- role/admin flags;
- owner/tenant/account IDs;
- status/approval/payment fields;
- balances, limits, price, or entitlement;
- internal visibility and lifecycle fields.

Schema presence alone is not an allowlist if the schema includes privileged fields for other callers.

### Confused Deputy and Service Identity

Check whether a privileged service performs an action for an untrusted caller without binding:

- original actor;
- tenant;
- requested resource;
- delegated scope/purpose;
- expiry or replay protection.

### Check/Use Mismatch

Verify the resource checked is the resource used. Watch for:

- checking parent A then mutating child from parent B;
- checking by one identifier and loading by another;
- authorization before canonicalization/redirect/resolution;
- async job receiving only object ID but losing actor/tenant context;
- policy result cached beyond membership or role changes.

## Deny-by-Default and Failure Behavior

Inspect missing/unknown policy outcomes, exceptions, unavailable policy services, and empty role sets. Security decisions should not silently fall back to allow unless an explicit, justified design says so.

## Framework and Architecture Checks

- Route decorators and middleware may enforce coarse authorization; still verify object/tenant policy.
- ORM query scoping can be the authorization control; prove it cannot be bypassed by alternate managers/raw queries.
- Policy objects may centralize checks; inspect actual subject/action/resource arguments.
- Database row-level security can mitigate application mistakes only if active for this connection/role and tenant context is safely set.

## Verification Scenarios

For a candidate, reason through at least:

1. user A vs user B in same tenant;
2. user A vs user B in different tenants;
3. ordinary user vs admin-only action;
4. stale membership/role/session;
5. bulk, export, background, and alternate endpoint variants.

## Remediation Direction

Prefer server-derived identity and tenant context, object-scoped queries, centralized policy evaluation, explicit field allowlists, fail-closed policy errors, and negative tests across principal and tenant boundaries.
