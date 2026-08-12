# Host power and console control

Host control targets one canonical compute Host. It never targets an Environment definition,
Environment Instance, Connector, hostname, JetKVM device ID, or legacy physical-machine ID by
reinterpretation.

The versioned server boundary provides:

- Host capability and power status;
- private, non-cacheable PNG screenshots with frame identity, dimensions, and freshness headers;
- typed power, key, chord, text, mouse-move, and mouse-click operations;
- actor-, Host-, binding-, policy-, and approval-bound replay with typed durable audit evidence;
- current-frame and coordinate checks for mouse input;
- persistent rate limiting after exact replay checks, bounded reservation recovery, and explicit
  provider/stale-frame errors.

The immutable v1 ledger remains retained after the v2 hardening migration. Its old untyped
results are never reinterpreted, and every retained owner/operation key remains permanently
fenced against reuse. New reservations carry a rotating attempt identity so an expired handler
cannot dispatch or complete after a newer handler safely reclaims the pre-dispatch lease.

Every keyboard, chord, text, and mouse action is classified as at least boot risk because the
server cannot independently prove whether the visible screen is a normal login, firmware,
recovery, or installer. A caller may raise that risk but cannot lower it. Every non-standard risk
requires an explicit approval identifier and two control-plane authorization decisions: once
before resolving the Host binding and again immediately before dispatch. Forced power-off is also
upgraded to boot risk. Firmware, disk, secure-boot, recovery, and installer work stays outside the
provider surface.

The provider contract is independent of SSH and the active operating system. Power-off, BIOS, and
normal login frame fixtures prove that the Host identity does not change with the visible screen.

The configured server exposes the Host route through the normal human and machine authentication
boundary. The existing production JetKVM binding supplies only fresh MQTT power status and
power-on; power-off remains blocked. High-risk actions remain denied until a trusted approval
authority can produce a current, durable decision. The real frame/HID adapter is tracked in #643
and remains fail-closed until a supported,
authenticated, version-pinned JetKVM API or reviewed local gateway contract exists. No private
firmware RPC, shell fallback, or browser-held credential is used in the meantime.
