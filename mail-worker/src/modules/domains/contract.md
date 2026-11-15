# Receiving domains

The primary node exposes administrator-only, CSRF-protected receiving domain management through the feature router.

- `GET /api/admin/domains` returns `{ data: { items, defaultDomain } }`.
- `POST /api/admin/domains` accepts `{ domain }`; returns the newly enabled domain with HTTP 201.
- `PUT /api/admin/domains/:domain` accepts a nonempty subset of `{ enabled: boolean, isDefault: boolean }`.
- A domain item contains `domain`, `enabled`, `isDefault`, `accountCount`, `mailboxCount`, `createdAt`, and `updatedAt`. Counts include all stored local accounts and main mailbox configurations, including disabled/deleted records, with an exact case-insensitive domain match.

Names normalize to lowercase ASCII (including IDNA). URLs, email addresses, ports, wildcards, IP addresses, empty/invalid labels, labels over 63 characters, and names over 253 ASCII characters are rejected. There can be at most 100 domains, including disabled entries. A duplicate normalized name returns HTTP 409. Domain names cannot be renamed or deleted.

Exactly one enabled domain is the default. Set another enabled domain's `isDefault` to `true` to switch it atomically. A disabled domain may become default in the same request as `enabled: true`. A default domain cannot be disabled or cleared until a replacement has been selected; at least one domain remains enabled. Administrative mutations and their audit records commit together. Audit failure rolls back the domain change and any default switch.

At first startup, `initializeDomains(env)` seeds the empty migrated table from `env.domain`, preserving the first normalized domain as default and deduplicating names. Subsequent startups use the persisted table and never reinsert environment-only names. Startup seeding is transactional and is not an administrator action. `activeDomains(env)` returns enabled domains with the default first; `knownDomains(env)` also includes disabled domains. Only legacy environments with no `mail_domain` table fall back to `env.domain`; real database failures propagate.

Disabling a domain restricts new mailbox creation. It does not alter existing users, login addresses, accounts, stored mail, main mailbox configuration, public identifiers, or mailbox links. Existing receiving paths should use `knownDomains`, while new-mailbox validation and suffix selectors should use `activeDomains`. The domain API does not provision DNS, MX records, TLS, or external mail routing.
