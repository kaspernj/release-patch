# release-patch

Bump the patch version, sync `master`, commit, push and publish an npm package — all with a single command.

`release-patch` wraps the repetitive steps of cutting a patch release so any package can adopt the same flow just by installing it.

## What it does

When run from a package's root directory, it:

1. Logs in to npm if you are not already authenticated (`npm login`).
2. Syncs `master` with `origin/master` (`git checkout master`, `git fetch`, `git merge`).
3. Bumps the patch version without creating a git tag (`npm version patch --no-git-tag-version`).
4. Runs `npm run build` **only if** the package defines a `build` script and its release lifecycle scripts do not already run `build`.
5. Commits `package.json` and `package-lock.json` when present (`chore: bump patch version`).
6. Pushes to `origin master`.
7. Publishes to npm (`npm publish`).

`npm version` already updates `package-lock.json` when present, so `release-patch` does not run `npm install`. This also avoids triggering `prepare` during install.

`npm publish` still runs npm lifecycle scripts such as `prepublishOnly`, `prepack`, and `prepare`. If one of those scripts runs `build`, `release-patch` skips its own explicit `npm run build` to avoid adding another build on top of npm's lifecycle builds.

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
