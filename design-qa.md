# Roadmap graph design QA

## Reference

- Approved direction: `/Users/oli/.codex/generated_images/019f749d-68e7-7010-9c09-a8f9ff730248/exec-b76b7b38-2e71-4aee-9404-d48043938d64.png`
- Desktop comparison: `/Users/oli/.codex/visualizations/2026/07/20/019f7f83-d441-7760-bda4-3081606db8b2/comparison-desktop-final.jpg`
- 390 px mobile comparison: `/Users/oli/.codex/visualizations/2026/07/20/019f7f83-d441-7760-bda4-3081606db8b2/comparison-mobile.jpg`
- Mobile inspector proof: `/Users/oli/.codex/visualizations/2026/07/20/019f7f83-d441-7760-bda4-3081606db8b2/roadmap-mobile-final-sheet.png`

## States reviewed

- Desktop graph with a selected issue and integrated inspector.
- 390 x 844 mobile graph and issue bottom sheet.
- Long issue titles, multiple roots, a dependency chain, a terminal leaf, and a goal boundary using current Project Space issue data.
- Add work, create goal with first issue, dependency add/remove, plan reordering, direct reload, browser history, and keyboard selection.

## Findings and resolutions

- P1: mobile controls originally left an empty grid row. The refresh control is now desktop-only and mobile actions occupy one compact row.
- P1: mobile graph nodes were too small at the initial fit. Compact fit now preserves a readable minimum zoom and allows intentional horizontal panning for wide multi-root graphs.
- P1: hidden responsive drawers could retain focus behavior. Desktop and mobile editor/inspector surfaces are now conditionally rendered.
- P2: the primary action lacked the approved green emphasis. It now uses the selected direction's green treatment while remaining an `Open` action owned by this feature.
- P2: nodes and dependency arrows needed explicit keyboard activation. Both now open the appropriate inspector state with Enter or Space.
- P2: goal boundaries could overlap in mixed goal layouts. Goals now occupy separate derived lanes without persisting positions.

## Result

Pass. No remaining P0, P1, or P2 visual issues were found in the compared desktop and mobile states. The implementation follows the approved graph-plus-inspector direction while retaining the existing Project Space shell and real persisted roadmap data.

---

# Hosts device workspace design QA

- Source visual truth: `/var/folders/hx/72mbhxpx26zdpt_z3k_ksvr80000gn/T/codex-clipboard-59da2f34-60cb-498e-941c-d7ae16471384.png`
- Rendered desktop: `/Users/oli/.codex/visualizations/2026/08/21/01a02307-855b-7961-bd37-50797f022b63/issue-732-hosts-device/implementation-desktop.png`
- Rendered mobile: `/Users/oli/.codex/visualizations/2026/08/21/01a02307-855b-7961-bd37-50797f022b63/issue-732-hosts-device/implementation-mobile.png`
- Full comparison: `/Users/oli/.codex/visualizations/2026/08/21/01a02307-855b-7961-bd37-50797f022b63/issue-732-hosts-device/full-comparison.png`
- Focused comparison: `/Users/oli/.codex/visualizations/2026/08/21/01a02307-855b-7961-bd37-50797f022b63/issue-732-hosts-device/focused-comparison.png`
- Desktop viewport: 1500 × 1446 CSS pixels at device scale factor 1
- Mobile viewport: 390 × 844 CSS pixels at device scale factor 1
- Source pixels: 1500 × 1446
- Desktop implementation pixels: 1500 × 1446
- Density normalization: none required for the desktop comparison
- State: dark theme, Tailnet device identity, animated mock telemetry, SSH terminal preview selected

## Full-view comparison evidence

The combined desktop comparison checks the same page hierarchy and dimensions. Both designs use a large device identity header, a four-column telemetry strip, a compact feed status row, terminal/remote controls, a dominant session surface, and a two-column hardware summary. The implementation intentionally uses the current DotNaos tokens, components, English product copy, and a consistent selected tool state.

## Focused region comparison evidence

The focused comparison covers the header, status metadata, all telemetry tiles, the tool controls, and the top of the terminal surface. The DotNaos metric tiles preserve the source's restrained dark surfaces and colored sparklines. The terminal surface keeps the source's visual weight while making the mock boundary explicit.

## Required fidelity surfaces

- Fonts and typography: the existing Project Space and DotNaos typography remains consistent; device identity, labels, metrics, terminal text, and detail rows retain the source hierarchy without forced uppercase styling.
- Spacing and layout rhythm: desktop proportions match the source after widening the terminal and metric tiles; the 390-pixel view has no horizontal overflow.
- Colors and tokens: every implemented surface, border, foreground, icon, status, and metric tone comes from DotNaos design tokens or DotNaos UI components.
- Image and asset quality: no source image asset was required for the shown terminal state; icons and operating-system marks use the DotNaos icon catalog. No CSS-drawn or placeholder art was introduced.
- Copy and content: real device identity and connectivity stay separate from clearly labeled preview telemetry, terminal, remote desktop, and hardware data.

## Interaction and console evidence

- Confirmed the telemetry feed updates and can be paused and resumed.
- Submitted `hostname` in the mock terminal and received the selected device name.
- Switched to Remote Desktop, started its preview session, and ended it without contacting a device.
- Confirmed the page has no horizontal overflow at 390 CSS pixels.
- Checked browser console and page errors after the final fix. No runtime errors remained; only Clerk's expected development-key warning was present.

## Comparison history

1. Initial browser pass found a P0 React update loop because fresh metric sample objects were appended on every render. The feed now gives DotNaos `useMetricHistory` stable numeric readings. The post-fix desktop and mobile captures show animated sparklines with no console errors.
2. Initial comparison found a P2 density mismatch: telemetry tiles and the terminal were materially shorter than the source. The final implementation increases metric and terminal height and constrains the workspace to the source's content width. The final full and focused comparison images show the corrected proportions.

## Findings

No actionable P0, P1, or P2 visual findings remain.

## Follow-up polish

- P3: the source mock mixes German labels with an English product shell. The implementation keeps Project Space's current English copy rather than introducing a page-local locale mismatch.
- P3: the persistent UI Dev trigger remains visible because it was explicitly requested for review.

final result: passed
