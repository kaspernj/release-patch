#!/usr/bin/env node
import {execSync} from "node:child_process"
import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"

// `preversion` runs before npm bumps package.json, so it cannot replace the release build.
const releaseLifecycleScriptNames = ["version", "postversion", "prepublishOnly", "prepack", "prepare"]

/** @param {string} command The shell command to run, inheriting stdio. */
function run(command) {
  execSync(command, {stdio: "inherit"})
}

/**
 * Reads the consuming package's `package.json` from the current working directory.
 * @returns {{scripts?: Record<string, string>}} The parsed package manifest.
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

const packageJson = readPackageJson()

// Bump patch version without creating a git tag.
run("npm version patch --no-git-tag-version")

// Build after the version bump unless npm lifecycle scripts already do it.
if (shouldRunExplicitBuild(packageJson)) {
  run("npm run build")
}

// Commit version bump and lockfile changes.
addVersionFiles()
run('git commit -m "chore: bump patch version"')

// Push to master.
run("git push origin master")

// Publish to npm (requires correct auth).
run("npm publish")
