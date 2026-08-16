# Single-tenant deployment ownership

Project Space is deployed once for one infrastructure ownership domain. That
domain can be one person, one team, or one organization. The deployment is the
tenant boundary: its database, projects, Hosts, Environments, agents, users,
and infrastructure integrations all belong to that one domain.

This is **single tenant, multi user**. A deployment may have many users and
service identities from that same ownership domain, with permissions that
decide what each one may do. It is
not a shared Project Space SaaS where unrelated customers or organizations are
stored in the same application instance. A different person or organization
gets a separate deployment and separate infrastructure credentials.

## Ownership model

```text
Project Space deployment
├── users and service identities
├── projects, Hosts, Environments, and agents
├── database
└── deployment-owned infrastructure integrations
    ├── Tailscale
    ├── GitHub application
    └── secret delivery
```

Users are authorized to perform bounded Project Space operations. They do not
select a tenant, provide another owner's infrastructure connection, or receive
the deployment's raw credentials. The deployment's authorization to external
infrastructure is separate from a person's sign-in identity.

Production requires an explicit `PROJECT_SPACE_ALLOWED_EMAILS` membership
list. An empty list fails closed: a valid Clerk session by itself does not
grant access to this deployment. Add or remove people through deployment
configuration and redeploy; never infer membership from an email domain.

## Infrastructure credentials

Long-lived credentials that establish the deployment's relationship with
infrastructure are deployment configuration, not user preferences or
application settings. They are supplied to the trusted backend by the
deployment secret manager and are never shown in the browser, stored in normal
application data, or committed to the repository.

For Tailscale, the runtime contract is:

```text
TAILSCALE_OAUTH_CLIENT_ID
TAILSCALE_OAUTH_CLIENT_SECRET
```

The OAuth client belongs to the tailnet and gives this deployment its bounded
API capability. Project Space exchanges it server-side for short-lived API
tokens. Authorized deployment members may see sanitized Tailscale health and inventory, and
may request actions they are authorized for, but never receive the client
secret or API token.

Production obtains these names from the dedicated Infisical Production project
through the approved deployment path. Other deployment targets use their own
secret manager or an equivalent protected runtime injection. Local development
must use a protected local secret mechanism; no credential value belongs in
source control.

## Consequences

- No application-wide `tenant_id` or `organization_id` is needed merely to
  separate unrelated customers; separate deployments provide that isolation.
- The explicit membership list defines who belongs to the deployment today. A
  future role model may narrow what those members can do; it does not turn one
  installation into a shared cross-organization service.
- Adding another ownership domain means deploying another Project Space
  instance with its own database and secret boundary.

See [Tailscale provider connections](tailscale-provider-connections.md) for the
provider contract and [Production deployment](production-deployment.md) and
[Infisical secret delivery](infisical-secret-delivery.md) for secret delivery.
