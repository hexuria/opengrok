# Electron-main production adapter tranche evidence

This inventory covers only the eight non-overlapping production binding slots
assigned to this tranche. Line numbers refer to the immutable
`src/app/dist/electron-main/main.cjs` payload from Grok Bot 0.18.0.

| Slot | Exact immutable anchor | Clean provider | Mandatory residual inputs |
| --- | --- | --- | --- |
| `adapters.attachmentGateway` | line 506233, `attachments: createAttachmentEdgePort({` | `createElectronProductionAttachmentGatewayBinding` | none; the zero-input binding consumes the real Electron ABI and the existing production context at runtime |
| `adapters.mainRpc` | line 506198, `const mainEdge = serveMainEdge({` | `createElectronProductionMainRpcBinding` → `createProductionMainRpcAdapter` | promoted reviewed source provider: zero-input binding closes live update/theme/egress/host-settings readers, event emitters, generated serve/contract/table defaults, Electron `ipcMain`, trusted WebContents, and broadcast; clean-main activation remains fail-closed only for the separate coordinator and IPC residuals |
| `adapters.accountOAuth` | line 505993, `var cursorAuthWiring = createCursorAuthWiring({` | `createElectronProductionAccountOAuthBinding` → `createProductionAccountOAuthAdapter` | zero-input wrapper is dependency-closed against the recovered auth wiring, standard LoginManager/secure-store owner, native browser callback, account runtime/status delivery, and host-settings synchronization |
| `adapters.experiments` | line 506018, `var experimentsRuntime = createExperimentsRuntime({` | `createProductionExperimentsAdapter` | concrete authenticated account service and coordinator feature-override push port; Statsig implementation is recovered clean source plus `@statsig/js-client` |
| `adapters.mcpOAuth` | line 506056, `var mcpRuntime = createMcpRuntime({` | `createProductionMcpOAuthAdapter` | Generated manager, runtime, loopback, and the shared secrets/resync `pushBoxSecrets` join are exact/tested; activation still requires the zero-input authenticated-account/coordinator list-refresh/loopback/telemetry production join and shell/IPC composition |
| `adapters.telemetry` | line 506459, `desktopTelemetry = await SandDesktopStructuredLogTelemetry.create({` | `createElectronProductionTelemetryBinding` → `createProductionTelemetryAdapter` | zero-input Electron wrapper is closed over the exact AnalyticsService clients, authenticated account-slot fencing, user-data spill, account status rotation, and disposal subscription |
| `adapters.coordinator` | line 506501, `const createCoordinatorSession = () => createCoordinatorRuntime({`; native join isolated in `coordinator-native.ts` | `composeElectronProductionCoordinatorBindings` + `createProductionCoordinatorAdapter` | Exact Electron `utilityProcess`, `MessageChannelMain`, network/power, WebAuthn `BrowserWindow`, and native local-exec ports are source-backed and Mac/Windows-identical; full promotion remains blocked on generated gateway/account-authorizer, complete account transition, resync/box-secrets, telemetry/event, and renderer-port joins |
| `adapters.ipc` | line 506728, `registerSecretsIpc({` | `createElectronProductionIpcBinding` → `createProductionIpcAdapter` | promoted reviewed source provider: zero-input Electron `ipcMain` join consumes the root-owned post-telemetry experiments/settings/secrets/MCP registrars, trusted sender guards, duplicate-channel checks, rollback, and reverse disposal; coordinator request IPC remains separately composed |

Provider construction validates every mandatory port and throws before exposing
a service when one is absent. The IPC provider preserves the shipped coordinator
→ telemetry → experiments → settings → secrets → MCP order, rejects duplicate
channels, rolls back partial registration, and removes listeners/handlers in
reverse order. MCP manager creation remains lazy; its desktop surface cannot open
an external URL until its IPC/OAuth controller has been registered.

These are provider constructors, not a fabricated production binding manifest.
The erased generated Connect/protobuf exports listed above must be supplied by a
separate evidence-backed binding module before any slot can be marked activated.
