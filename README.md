# release-patch

Bump the patch version, sync `master`, commit, tag, push and publish an npm package — all with a single command.

`release-patch` wraps the repetitive steps of cutting a patch release so any package can adopt the same flow just by installing it.

**Git tags are the source of truth for versioning.** The next version is derived from the latest annotated `vX.Y.Z` tag, never from the `version` field in `package.json`.

## What it does

When run from a package's root directory, a normal patch release:

1. Verifies the working tree is clean (`git status --porcelain`) and aborts on uncommitted changes, before touching any branch, so stray edits can never leak into the release commit and syncing `master` can never clobber uncommitted work.
2. Syncs `master` with `origin/master` (`git checkout master`, `git fetch`, then a fast-forward-only `git merge --ff-only origin/master`). If local `master` has diverged from `origin`, the sync fails loudly instead of inventing a merge commit that would then be tagged and published as a release.
3. Reads and validates `package.json` **from the synced `master` checkout** (never stale feature-branch metadata): it must declare a `name` that npm itself accepts (validated with [`validate-npm-package-name`](https://www.npmjs.com/package/validate-npm-package-name), so scoped names pass and bad characters, capitals, length or reserved names fail) and must not be marked `"private": true`. A missing, invalid or private name fails here, before any release mutation.
4. Logs in to npm if you are not already authenticated (`npm login`).
5. Fetches tags (`git fetch origin --tags`) and enumerates them with `git for-each-ref`, keeping only **annotated** `vX.Y.Z` tag objects. Lightweight tags, pre-release/build tags and malformed tags are ignored — an annotated `v1.0.0` wins over a lightweight `v9.9.9`. The latest annotated tag is the current released baseline. If no valid annotated release tag exists, it fails clearly with bootstrap instructions instead of guessing.
6. Confirms the latest annotated tag is actually published on npm. A normal release never skips an unpublished latest tag: if the baseline tag is not on npm, it blocks with instructions to inspect it and, if it was tagged but never published, finish it with `release-patch --resume`.
7. Derives the next version by incrementing the patch component of the published latest tag, and checks the registry for that exact `<package>@<version>` (`npm view <package>@<version> version`), passing the package name as a process argument, never through a shell. If that exact version already exists, it fails as a duplicate. Only an unambiguous npm `E404` code means the version is available; any other outcome — a network/auth/registry error, or an `E404` mixed with another error code — is treated as blocking uncertainty, and the release aborts before any mutation rather than risk an overwrite or a race.
8. Installs dependencies (`npm install`, or `npm install --no-package-lock` when neither `package-lock.json` nor `npm-shrinkwrap.json` exists).
9. Writes the exact derived version without creating a git tag (`npm version <version> --no-git-tag-version`).
10. Runs `npm run build` **only if** the package defines a `build` script and its `version`/`postversion` lifecycle scripts do not already run `build`.
11. Runs a publish dry-run (`npm publish --dry-run`) as a gate — **before** creating the release commit or tag — so a bad tarball or packaging error surfaces while everything is still local. The dry-run pushes no Git refs and publishes no package, though its lifecycle scripts (`prepublishOnly`, `prepack`, `prepare`) may still have external side effects. Running it before the commit and tag means a failed dry-run leaves no local tag behind to poison the next version derivation.
12. Commits exactly `package.json`, `package-lock.json` and `npm-shrinkwrap.json` when present (`chore: bump patch version`), each staged by name — never `git add -A`. This commit is the exact release commit.
13. Refuses to continue if any tracked or untracked, non-ignored change remains in the working tree after that commit. A build or dry-run lifecycle script that emits generated files or secrets outside the intended commit blocks the release with an actionable error rather than being swept into the tag and push.
14. Creates an annotated tag on that release commit (`git tag -a v<version> -m v<version>`).
15. Pushes the release commit and its exact tag to `origin` atomically in a single non-force push (`git push --atomic origin master v<version>`), so `master` is never published without its matching release tag.
16. Publishes to npm (`npm publish`). If the publish fails **after** the atomic push, the commit and tag are already public, so it surfaces precise recovery instructions to finish with `release-patch --resume` and preserves the non-zero exit.
17. Verifies the published version is live on the registry (`npm view <package>@<version> version`). Because npm's read path can lag a successful publish, verification makes up to 10 attempts across a bounded 150-second window (waiting 1, 2, 4, 8, 15, then 30 seconds between checks) and prints progress before each wait. Only an unambiguous `E404` is retried; network, authentication, mixed-code, and other ambiguous registry errors fail closed immediately. If the version remains unavailable after the bounded window, the command exits non-zero and directs recovery through `release-patch --resume`; it never publishes again as a fallback. The package name comes from `package.json` and is passed as a process argument, never through a shell, so hostile metadata cannot inject commands.

The manifest is read and validated from the fast-forwarded `master`, and the baseline-published and duplicate preflights run, before any release mutation — so validation and duplicate detection reflect exactly what will be published, and no version bump, commit, tag, push, dry-run, or publish happens until the version is confirmed available. The clean-tree check and the `master` sync are the only Git side effects that precede validation. The install step runs before the version write so `version` lifecycle scripts and the pre-push build gate use dependencies from the synced package. The version is derived from tags *before* the install so the release fails fast when no valid tag exists.

Because the annotated tag is created on the release commit itself (rather than relying on `npm version`'s implicit commit/tag), the tag always points at exactly the commit that records the version bump. Only `package.json`, `package-lock.json` and `npm-shrinkwrap.json` (when present) are committed; the `npm run build` step is a pre-push gate whose output is intentionally **not** committed (and, if it produces non-ignored files, is caught by the stray-change check). `npm publish` produces the published artifact from a fresh build via its own lifecycle scripts.

`npm publish` still runs npm lifecycle scripts such as `prepublishOnly`, `prepack`, and `prepare`. Those hooks run after `release-patch` pushes the version commit, so they do not replace the pre-push build gate.

## Resuming an interrupted release

A release can be interrupted after the commit and tag are pushed but before the publish succeeds — for example a flaky network or a registry hiccup on `npm publish`. Because the tag now exists but the version is not on npm, a normal release would refuse to continue (it will not skip an unpublished latest tag). Finish the exact tagged version with:

```sh
release-patch --resume
```

`--resume` publishes the **existing** latest annotated tag without bumping, committing or creating another tag. It only proceeds when the tag points at the current synced `master` HEAD and `package.json`'s version exactly matches the tag, so it can never publish a tree the tag does not record. It re-runs the dependency, build and dry-run gates, safely re-pushes the exact `master`/tag atomically (a no-op when they are already on `origin`), publishes that exact version and verifies it. If the version is already published, `--resume` is a verified no-op. Resume cannot be combined with another release mode.

## Reconciling an untagged published baseline

Use this guarded package-owned mode only when npm already contains the patch immediately after the latest annotated release tag, but that published patch has no tag:

```sh
release-patch --reconcile-published 0.5.10
```

The version argument is mandatory and must be exact `X.Y.Z`. The command reads `version` and `gitHead` together from npm for that exact package version, then fails closed unless all of the following are true:

- the requested version is exactly one patch after the latest annotated tag (or is the exact tag from a partially completed reconciliation);
- npm returns that exact version and one full 40-character lowercase hexadecimal `gitHead`;
- the commit exists after syncing `master` and fetching origin, and is an ancestor of authoritative `origin/master`;
- `package.json` at that commit has the same package name as current synced `master` and exactly the requested version;
- the baseline tag is absent, or is already the same annotated tag on that exact commit after an interrupted attempt; and
- the following patch version is definitely absent from npm.

Only after every check succeeds does the command create and non-force-push the missing annotated baseline tag. It then runs the ordinary release transaction unchanged, deriving and publishing the following patch. It never checks out or changes the historical commit, never moves or replaces an existing tag, and never weakens normal duplicate detection or `--resume`.

Recovery is rerunning the exact same helper invocation. If baseline tag creation fails, nothing was pushed and no release commit was made. If its push fails, an exact local tag may remain; the retry re-fetches authoritative tags and recreates or accepts only the verified exact tag. If the baseline tag is pushed but the following normal release fails before its atomic release push, rerun the same reconciliation invocation. If that normal release's atomic push succeeded but npm publishing failed, follow its printed `release-patch --resume` instruction, exactly as for any ordinary release.

## Bootstrapping a brand-new package

The next version is always derived from the latest **published** annotated tag, so a brand-new package needs one published tag to start from. Create an annotated tag that matches `package.json` and the current `HEAD`, then publish that initial version with `--resume`:

```sh
git tag -a v0.0.0 -m v0.0.0   # package.json version must be 0.0.0 and HEAD must be the tagged commit
release-patch --resume        # pushes the tag and publishes v0.0.0
```

From then on, ordinary `release-patch` runs derive each next patch from the published tag.

## Install

```sh
npm install --save-dev release-patch
```

## Usage

Add a script to your `package.json`:

```json
{
  "scripts": {
    "release:patch": "release-patch"
  }
}
```

Then cut a release:

```sh
npm run release:patch
```

You can also run it ad hoc without adding a script:

```sh
npx release-patch
```

## Requirements

- The package is a git repository with a `master` branch and an `origin` remote, and a clean working tree (no uncommitted changes) when you run the release.
- `package.json` declares a `name` that npm accepts (validated with `validate-npm-package-name`) and is not marked `"private": true`.
- At least one **annotated** release tag in `vX.Y.Z` form exists (for example `v1.0.0`), and that latest tag is published on npm. Lightweight tags are ignored. This published tag is the source of truth for the current released version. To bootstrap a brand-new package, see [Bootstrapping a brand-new package](#bootstrapping-a-brand-new-package).
- You have publish rights to the package on npm.

## License

ISC
