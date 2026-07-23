# release-patch

Bump the patch version, sync `master`, commit, tag, push and publish an npm package — all with a single command.

`release-patch` wraps the repetitive steps of cutting a patch release so any package can adopt the same flow just by installing it.

**Git tags are the source of truth for versioning.** The next version is derived from the latest annotated `vX.Y.Z` tag, never from the `version` field in `package.json`.

## What it does

When run from a package's root directory, it:

1. Logs in to npm if you are not already authenticated (`npm login`).
2. Syncs `master` with `origin/master` (`git checkout master`, `git fetch`, `git merge`).
3. Fetches tags (`git fetch origin --tags`) and derives the next version from the latest valid `vX.Y.Z` Git tag, incrementing its patch component. `package.json` is ignored as a version source. If no valid release tag exists, or the tag output is malformed, it fails clearly instead of guessing.
4. Installs dependencies (`npm install`, or `npm install --no-package-lock` when neither `package-lock.json` nor `npm-shrinkwrap.json` exists).
5. Writes the exact derived version without creating a git tag (`npm version <version> --no-git-tag-version`).
6. Runs `npm run build` **only if** the package defines a `build` script and its `version`/`postversion` lifecycle scripts do not already run `build`.
7. Commits `package.json` and `package-lock.json` when present (`chore: bump patch version`). This commit is the exact release commit.
8. Creates an annotated tag on that release commit (`git tag -a v<version> -m v<version>`).
9. Pushes the release commit and its exact tag to `origin` atomically in a single non-force push (`git push --atomic origin master v<version>`), so `master` is never published without its matching release tag.
10. Publishes to npm (`npm publish`).
11. Verifies the published version is live on the registry (`npm view <package>@<version> version`).

The install step runs before the version write so `version` lifecycle scripts and the pre-push build gate use dependencies from the synced package. The version is derived from tags *before* the install so the release fails fast when no valid tag exists.

Because the annotated tag is created on the release commit itself (rather than relying on `npm version`'s implicit commit/tag), the tag always points at exactly the commit that records the version bump. Only `package.json` and `package-lock.json` (when present) are committed; the `npm run build` step is a pre-push gate whose output is intentionally **not** committed. `npm publish` produces the published artifact from a fresh build via its own lifecycle scripts.

`npm publish` still runs npm lifecycle scripts such as `prepublishOnly`, `prepack`, and `prepare`. Those hooks run after `release-patch` pushes the version commit, so they do not replace the pre-push build gate.

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

- The package is a git repository with a `master` branch and an `origin` remote.
- At least one annotated release tag in `vX.Y.Z` form exists (for example `v1.0.0`). This tag is the source of truth for the current released version. To bootstrap a brand-new package, create and push an initial tag once: `git tag -a v0.0.0 -m v0.0.0 && git push origin v0.0.0`.
- You have publish rights to the package on npm.

## License

ISC
