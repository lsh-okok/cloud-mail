# Site administrators

Management routes use the existing primary-node authentication, live user checks, configured origin and session-bound CSRF protection.

- `GET /api/admin/administrators` returns `{ data: { items } }` with `userId`, `email`, `isAdministrator`, `active` and `grantedAt`.
- `PUT /api/admin/users/:userId/administrator` accepts exactly `{ enabled: boolean }`, returning `{ data: { userId, email, isAdministrator, changed } }`.

Only an active super administrator can grant or revoke membership, including a fresh check inside the immediate write transaction. Grants require a usable existing user and matching primary mailbox. Repeated requests are idempotent. Revocation requires another usable administrator. Member changes, audit and target session invalidation commit together. Revocation also invalidates the site public integration token. An audit failure rolls back the whole change.

Migration 6 creates `site_administrator` and a singleton initialization marker. The first bootstrap seeds membership from the configured initial administrator. After initialization, the database is authoritative; restarting or changing the configured address never recreates or regrants a revoked account. Foreign keys retain other members when an original grantor is removed. Replicas cannot administer membership.

`isAdministrator` checks stored membership regardless of user status for protecting administrator targets. `isSuperAdmin` requires membership plus a currently active, undeleted database user for authorization. The configured-address fallback applies only to legacy databases without the membership table. A user's role ID or role name never grants membership.

Legacy user operations protect administrator accounts until explicit revocation. Delegated user managers cannot change administrator passwords or restore administrator accounts; direct deletion of a user's primary login mailbox is rejected.
