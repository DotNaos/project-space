# Host power and console control

Host control targets one canonical compute Host. It never targets an Environment definition,
Environment Instance, Connector, hostname, JetKVM device ID, or legacy physical-machine ID by
reinterpretation.

The versioned server boundary provides:

- Host capability and power status;
- private, non-cacheable PNG screenshots with frame identity, dimensions, and freshness headers;
- typed power, key, chord, text, mouse-move, and mouse-click operations;
- exact operation replay and durable audit evidence;
- current-frame and coordinate checks for mouse input;
- rate limiting and explicit provider/stale-frame errors.

Boot keys such as `F2`, `F10`, `F12`, and `Delete`, plus `Ctrl-Alt-Delete`, are classified as
boot-risk actions by the server even if a caller labels them standard. Every non-standard risk
requires an explicit approval identifier and control-plane authorization. Forced power-off is
also upgraded to boot risk rather than trusting a caller-supplied standard label. Firmware, disk,
secure-boot, recovery, and installer work stays outside the provider surface.

The provider contract is independent of SSH and the active operating system. Power-off, BIOS, and
normal login frame fixtures prove that the Host identity does not change with the visible screen.

The existing production JetKVM binding currently supplies only the separately secured MQTT power
path. The real frame/HID adapter is tracked in #643 and remains fail-closed until a supported,
authenticated, version-pinned JetKVM API or reviewed local gateway contract exists. No private
firmware RPC, shell fallback, or browser-held credential is used in the meantime.
