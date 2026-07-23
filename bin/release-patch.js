#!/usr/bin/env node
import {execFileSync, execSync} from "node:child_process"
import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"

// `preversion` runs before the version bump, and publish hooks run after the push.
const releaseLifecycleScriptNames = ["version", "postversion"]

/** @param {string} command The shell command to run, inheriting stdio. */
function run(command) {
  execSync(command, {stdio: "inherit"})
}

/**
 * Runs a command with explicit arguments and no shell, so dynamic values cannot be interpreted
 * as shell syntax. Use this whenever untrusted package metadata crosses the process boundary.
 * @param {string} file The executable to run.
 * @param {string[]} args The arguments passed verbatim to the executable.
 */
function runArgs(file, args) {
  execFileSync(file, args, {stdio: "inherit"})
}

/**
 * Runs a command and captures its stdout so it can drive release decisions.
 * @param {string} command The shell command to run.
 * @returns {string} The command's stdout.
 */
function runCapture(command) {
  return execSync(command, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]})
}

// Each component is a plain non-negative integer with no leading zeros, matching semver's
// numeric-identifier grammar; this rejects forms like `v01.2.3` instead of canonicalizing them.
/** Matches an exact `vX.Y.Z` release tag with no pre-release or build metadata. */
const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

/**
 * Reads the consuming package's `package.json` from the current working directory.
 * @returns {{name: string, scripts?: Record<string, string>}} The parsed package manifest.
 */
function readPackageJson() {
  const packageJsonPath = resolve(process.cwd(), "package.json")

  return JSON.parse(readFileSync(packageJsonPath, "utf8"))
}

/** Logs in to npm if there is no authenticated user yet. */
function ensureNpmAuth() {
  try {
    execSync("npm whoami", {stdio: "ignore"})
  } catch {
    run("npm login")
  }
}

/** Ensures the release runs from the latest local `master` synced with `origin/master`. */
function ensureLatestMaster() {
  run("git checkout master")
  run("git fetch origin")
  run("git merge origin/master")
}

/**
 * Parses a git tag into its semver components when it is an exact `vX.Y.Z` release tag.
 * @param {string} tag A single git tag line.
 * @returns {{major: number, minor: number, patch: number} | null} The parsed version or null.
 */
function parseReleaseTag(tag) {
  const trimmed = tag.trim()
  const match = releaseTagPattern.exec(trimmed)

  if (!match) return null

  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)

  // A well-formed tag can still carry a component too large to represent exactly; fail loudly
  // rather than silently losing precision when deriving or comparing versions.
  if (![major, minor, patch].every((component) => Number.isSafeInteger(component))) {
    throw new Error(
      `release-patch: release tag ${trimmed} has a version component beyond the safe integer range; ` +
      "refusing to guess the next version."
    )
  }

  return {major, minor, patch}
}

/**
 * Compares two parsed semver versions.
 * @param {{major: number, minor: number, patch: number}} a The first version.
 * @param {{major: number, minor: number, patch: number}} b The second version.
 * @returns {number} A negative, zero or positive ordering result.
 */
function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Fetches tags and derives the next patch version from the latest `vX.Y.Z` Git tag.
 * Git tags are the source of truth, so `package.json` is never consulted for the version.
 * @returns {string} The next patch version in `X.Y.Z` form.
 */
function deriveNextPatchVersion() {
  // Tags must be fetched before the version can be calculated from them.
  run("git fetch origin --tags")

  const output = runCapture('git tag --list "v*.*.*"')
  const versions = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseReleaseTag)
    .filter((version) => version !== null)

  if (versions.length === 0) {
    throw new Error(
      "release-patch: could not find a valid vX.Y.Z release tag to derive the next version from. " +
      "Create an initial annotated release tag (for example: git tag -a v0.0.0 -m v0.0.0 && git push origin v0.0.0)."
    )
  }

  const latest = versions.reduce((highest, version) => (compareVersions(version, highest) > 0 ? version : highest))
  const nextPatch = latest.patch + 1

  if (!Number.isSafeInteger(nextPatch)) {
    throw new Error(
      `release-patch: the latest release tag v${latest.major}.${latest.minor}.${latest.patch} has a patch ` +
      "component at the safe integer limit and cannot be incremented; bump the minor or major version manually."
    )
  }

  return `${latest.major}.${latest.minor}.${nextPatch}`
}

/** Installs dependencies for the synced package before release lifecycle scripts can run. */
function installDependencies() {
  if (
    existsSync(resolve(process.cwd(), "package-lock.json")) ||
    existsSync(resolve(process.cwd(), "npm-shrinkwrap.json"))
  ) {
    run("npm install")
  } else {
    run("npm install --no-package-lock")
  }
}

/**
 * Checks whether a package script invokes the package's build script.
 * @param {string | undefined} script The package script command to inspect.
 * @returns {boolean} Whether the script invokes `build` through a package manager.
 */
function scriptRunsBuild(script) {
  return /(?:^|[\s;&|()])(?:npm\s+(?:run(?:-script)?\s+)?|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?)build(?:$|[\s;&|)])/u.test(script ?? "")
}

/**
 * Determines whether release-patch should run its own build command.
 * @param {{scripts?: Record<string, string>}} packageJson The consuming package manifest.
 * @returns {boolean} Whether release-patch should run `npm run build` explicitly.
 */
function shouldRunExplicitBuild(packageJson) {
  return Boolean(packageJson.scripts?.build) && !releaseLifecycleScriptNames.some((scriptName) => {
    return scriptRunsBuild(packageJson.scripts?.[scriptName])
  })
}

/** Stages the files changed by the version bump. */
function addVersionFiles() {
  run("git add package.json")

  if (existsSync(resolve(process.cwd(), "package-lock.json"))) {
    run("git add package-lock.json")
  }
}

ensureNpmAuth()
ensureLatestMaster()

// Git tags are the source of truth: derive the next version before touching package metadata.
const nextVersion = deriveNextPatchVersion()
const releaseTag = `v${nextVersion}`

installDependencies()

const packageJson = readPackageJson()
const packageName = packageJson.name

// Set the exact derived version without creating a git tag; we tag the release commit ourselves below.
run(`npm version ${nextVersion} --no-git-tag-version`)

// Build after the version bump unless npm lifecycle scripts already do it.
if (shouldRunExplicitBuild(packageJson)) {
  run("npm run build")
}

// Commit version bump and lockfile changes; this commit is the exact release commit.
addVersionFiles()
run('git commit -m "chore: bump patch version"')

// Create an annotated tag on the release commit before pushing anything.
run(`git tag -a ${releaseTag} -m ${releaseTag}`)

// Push the release commit and its exact tag together atomically, never forcing, so master is
// never published without the matching release tag if the tag push would fail on its own.
run(`git push --atomic origin master ${releaseTag}`)

// Publish to npm (requires correct auth).
run("npm publish")

// Verify the exact version is available on the registry. The package name comes from package.json,
// so it is passed as an argument (never through a shell) to avoid command injection.
runArgs("npm", ["view", `${packageName}@${nextVersion}`, "version"])
