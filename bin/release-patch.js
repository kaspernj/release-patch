#!/usr/bin/env node
import {execSync} from "node:child_process"
import {readFileSync} from "node:fs"
import {resolve} from "node:path"

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

const packageJson = readPackageJson()

ensureNpmAuth()
ensureLatestMaster()

// Build first if the consuming package defines a build script.
if (packageJson.scripts?.build) {
  run("npm run build")
}

// Bump patch version without creating a git tag.
run("npm version patch --no-git-tag-version")

// Install dependencies so the lockfile reflects the new version.
run("npm install")

// Commit version bump and lockfile changes.
run("git add package.json package-lock.json")
run('git commit -m "chore: bump patch version"')

// Push to master.
run("git push origin master")

// Publish to npm (requires correct auth).
run("npm publish")
