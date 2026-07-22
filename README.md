# release-patch

Bump the patch version, sync `master`, commit, push and publish an npm package — all with a single command.

`release-patch` wraps the repetitive steps of cutting a patch release so any package can adopt the same flow just by installing it.

## What it does

When run from a package's root directory, it:

1. Logs in to npm if you are not already authenticated (`npm login`).
2. Syncs `master` with `origin/master` (`git checkout master`, `git fetch`, `git merge`).
3. Installs dependencies (`npm install`, or `npm install --no-package-lock` when neither `package-lock.json` nor `npm-shrinkwrap.json` exists).
4. Bumps the patch version without creating a git tag (`npm version patch --no-git-tag-version`).
5. Runs `npm run build` **only if** the package defines a `build` script and its `version`/`postversion` lifecycle scripts do not already run `build`.
6. Commits `package.json` and `package-lock.json` when present (`chore: bump patch version`).
7. Pushes to `origin master`.
8. Publishes to npm (`npm publish`).

The install step runs before the version bump so `version` lifecycle scripts and the pre-push build gate use dependencies from the synced package.

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
- You have publish rights to the package on npm.

## License

ISC
