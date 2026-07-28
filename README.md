# Personal OpenCode Runtime

## Ownership

- `vendor/opencode-bundle/` is a read-only snapshot of the shared framework.
- `skills/` contains personal-only skills and managed framework symlinks.
- `agents/subagents/documentation.md` is personal-only.
- `opencode.json` is personal configuration; secrets use environment references.

## Office Machine

Develop shared assets only in the framework checkout. Run:

```bash
./scripts/sync-framework-bundle.sh /PATH/TO/OpenCode
git add vendor/opencode-bundle .gitignore README.md scripts
git commit -m "chore: sync framework bundle snapshot"
```

The active office runtime uses symlinks from the framework checkout, not the vendor snapshot.

## Personal Laptop

After pulling the personal repository, run:

```bash
./scripts/install-vendored-bundle.sh
```

This creates managed symlinks to `vendor/opencode-bundle/`. Re-run after a snapshot adds or removes assets.

Do not edit `vendor/opencode-bundle/` directly. Make shared changes in the framework checkout and sync a new snapshot.

## Automatic Runtime Refresh

Enable versioned hooks once on each machine:

```bash
./scripts/enable-hooks.sh
```

After that, `post-merge` refreshes runtime links after every successful `git pull` for an already installed bundle.
On an office machine it uses the framework checkout; on a personal laptop it uses the vendored snapshot.

Before a personal-repository commit on an office machine, `pre-commit` rejects a stale vendored snapshot.
Run `./scripts/sync-framework-bundle.sh` before retrying.
