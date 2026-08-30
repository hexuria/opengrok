# Publishing checklist

The `codex/clean` branch removes generated recovery material from its tree, but
its parent commit still contains that material. Do not push the branch and
assume the deleted files are absent from Git history.

Create a new repository from an archive of the clean commit:

```sh
git archive --format=tar codex/clean | tar -xf - -C /path/to/empty-export
cd /path/to/empty-export
git init
git add .
git commit -m "Initial reconstructed source import"
```

The preserved installers use Git LFS. Install LFS before the initial `git add`,
then push the objects after adding the remote:

```sh
git lfs install
git add .
git commit -m "Initial reconstructed source import"
git push -u origin main
git lfs push --all origin
```

If the hosting service offers downloadable source archives, enable its option
to include Git LFS objects in those archives; otherwise generated ZIP/tarball
downloads may contain only LFS pointer files.

Before adding a public remote:

1. Run `npm run publication:check` on the committed clean branch. It performs
   the archive/init/add flow above and requires the new index to have the exact
   same Git tree.
2. Run `npm ci`, `npm run bootstrap`, `npm run check`, `npm run package`, and
   `npm run verify` from a fresh clone/export.
3. Confirm `git status --ignored` shows no generated payload selected for Git.
4. Run `git lfs ls-files` and verify both preserved 0.18.0 installers appear.
5. Scan the exported tree and full new history for credentials and absolute
   machine paths.
6. Review `NOTICE.md` and obtain an independent rights review. No upstream
   license is supplied by this repository.
7. Decide on a license only for material you have authority to license; do not
   imply that license covers the upstream application or trademarks.
