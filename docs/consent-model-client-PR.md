# Client PR — consent-model cleanup (Part B)

Branch: `reverse-exec-daemon-descriptor` → `main` (repo `hexuria/opengrok`, private).
Paired server PR: `gol/web-console` in `opengrok-server`. Two repos, two PRs; merge both.

## Title
`consent model: one Mac switch, one card, deletable rules, two-tier auto-review (client half)`

## Body

Implements Part B of the one-consent-model plan
(`docs/... sparkling-hatching-quilt.md`). The client configures; the server
decides. Eight consent-model slices, each a focused commit with a why-body:

- **b1** (`bd79197`) the Mac switch becomes an on/off kill switch — daemon-side
  "ask", the 90s hold, the approvalId check and the dead prompt watcher deleted;
  legacy `always`/`ask` map to on, only explicit `never` is off (per the GOAL's
  "default ON after enrol"; keeps the enrolled Mac working). One On/Off toggle.
- **b2** (`6aae70c`) the card's Always/Never write a server rule only — removed
  the local-permission flip in all three sites; killed the "Never turns the whole
  Mac off" bug.
- **b3** (`7f65363`) standing rules are a visible, deletable list via the live
  `DELETE /local-exec/policy/rule`.
- **b4-global** (`14fedd5`) the General-tab auto-review mirrors to the server as
  the global tier.
- **b4-coworker** (`b93cec9`, `d16c149`, `5e65d1c`) the per-agent tier: edges +
  a DOM-injected agent-settings widget (tri-state, allow/block, "inherited from
  global" badge from `/auto-review/effective`).
- **b5** (`7353c19`, `35657f1`, `013ab36`) the acceptance list with screenshots.

## Verification (evidence in docs/consent-model-B5-acceptance.md + docs/consent-model-evidence/)
- `npm run check`: 258 tests green (includes tests that exercise the SHIPPED
  router-renderer-patch components, not the recovered tree).
- CDP, packaged app, live server on :1447: B1 toggle, B3 three deletable rows,
  B4 per-agent save→coworker→badge→reset — all screenshotted.
- Joint acceptance (live judge): a block rule refused `brew install jq` naming
  the rule with no card; one auto-review-approval card → Allow once → same
  entryId flipped → run resumed. Both paired with server-side rows.
- Cross-review: the server session reviewed these diffs (no findings); this
  session reviewed the server's wire (no findings).

## One accepted-v1 scope note
The auto-review card's "Always allow" writes the **global** tier, not per-agent —
the pinned 0.18 card has no `proposedRule`. Accepted for v1 (the agent-settings
widget is the per-agent path). Not a defect.

## Not a merge signal
CI is known-red from a billing hole. The gate is the server's
`scripts/gate.sh --smoke`.
