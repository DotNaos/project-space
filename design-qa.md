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
