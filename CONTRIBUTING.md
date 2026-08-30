# Contributing

This repository is intended for a small technical study group. Keep changes
reviewable and do not commit generated application payloads or local evidence.

Before sharing a change, run:

```sh
npm ci
npm run check
npm run frontend:build
```

On macOS, after `npm run bootstrap`, package changes should also pass:

```sh
npm run package
npm run verify
```

Use focused commits. Explain whether a change affects reviewed runtime source,
the editable frontend, the checksum-pinned packaged renderer, or packaging only.
Do not weaken checksum, bundle identity, code-signing, or clean-export checks to
make a build pass.
