# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The upstream 0.18.0 application is an external, checksum-pinned build input.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. Build
scripts stage that baseline, compile reviewed source runtimes, overlay eligible
clean outputs, apply the reconstructed updater guard, and pack a new ASAR.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.
