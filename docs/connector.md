# Retired Project Space Connector

The permanent Project Space Connector is retired. New installations and
Codespaces do not install, enroll, or start a long-lived Connector process.
There is no deprecation window or compatibility setup path to wait for.

Use the canonical runtime flow instead:

1. Register the machine once with `project connect`. This stores an
   owner-bound Machine Credential; it does not start a background process.
2. Discover an exact Environment Instance with `project environment list
   --format json`.
3. Start the requested, pinned Workspace Runtime with `project environment
   bootstrap <environment-instance>` and its required identity, commit, and
   manifest flags.
4. Manage the resulting generation with the Workspace Runtime lifecycle
   commands documented in [Workspace runtimes](./workspace-runtimes.md).

An Environment is the execution boundary. A Workspace Runtime is the
generation-scoped process or devcontainer that runs Codex and declared
development services. Runtime sessions are outbound, short-lived, and bound
to the exact Environment, Workspace, generation, manifest, and owner; they do
not require a permanent Connector installation. See [Compute Platforms,
Hosts, and Environments](./compute-environments.md) and [Workspace Runtime
sessions](./workspace-runtime-sessions.md).

## Existing installations

Older releases may have left a Connector executable, service, scheduled task,
LaunchAgent, registration token, or Connector configuration behind. Those are
cleanup targets only. Do not start the old executable or recreate its service.
The current owner-bound Machine Credential used by `project connect` is a
separate canonical credential and must not be deleted as if it were a legacy
Connector token.

The current platform installers retain narrow, explicit cleanup for known old
artifacts. Run the normal uninstall or upgrade path for the platform and verify
the exact service/task/artifact it removed. Keep unrelated user-owned files
untouched; a failed or offline cleanup must be retried with the same scoped
installer rather than replaced with broad recursive deletion.

The signed machine-tools release manifest remains
`project-space.connector-runtime-release/v1`. Existing clients parse that
schema, so retirement does not change the manifest envelope, parser, or trust
roots.
