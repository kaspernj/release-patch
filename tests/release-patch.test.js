import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join, resolve} from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDirectory, "..")
const releasePatchBin = join(projectRoot, "bin/release-patch.js")
const projectPackageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))

/**
 * Runs the CLI with fake npm and git commands and returns the command log.
 * @param {{name?: string, version?: string, scripts: Record<string, string>}} packageJson The package manifest to write.
 * @param {{packageLock?: boolean, shrinkwrap?: boolean, tags?: string[]}} [options] Additional package fixture options.
 * @returns {string[]} The command lines invoked by the CLI.
 */
function runReleasePatch(packageJson, options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "release-patch-test-"))

  try {
    const fakeBin = join(workspace, "bin")
    const packageRoot = join(workspace, "package")
    const commandLog = join(workspace, "commands.log")
    const manifest = {name: "fixture-package", version: "0.0.0", ...packageJson}
    // Git tags are the source of truth; default to a single tag so a next patch can be derived.
    const tags = options.tags ?? ["v1.0.1"]

    mkdirSync(fakeBin)
    mkdirSync(packageRoot)
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2))
    if (options.packageLock) {
      writeFileSync(join(packageRoot, "package-lock.json"), "{}\n")
    }
    if (options.shrinkwrap) {
      writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), "{}\n")
    }
    writeExecutable(join(fakeBin, "npm"), fakeCommandScript("npm"))
    writeExecutable(join(fakeBin, "git"), fakeGitScript())

    execFileSync(process.execPath, [releasePatchBin], {
      cwd: packageRoot,
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
        GIT_TAGS: tags.join("\n"),
        PATH: `${fakeBin}:${process.env.PATH}`
      },
      stdio: "pipe"
    })

    return readFileSync(commandLog, "utf8").trim().split("\n")
  } finally {
    rmSync(workspace, {force: true, recursive: true})
  }
}

/**
 * Writes an executable test command.
 * @param {string} path The executable path.
 * @param {string} contents The executable contents.
 */
function writeExecutable(path, contents) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

/**
 * Builds a fake command script that appends every invocation to COMMAND_LOG.
 * @param {string} commandName The command name to record.
 * @returns {string} The executable script contents.
 */
function fakeCommandScript(commandName) {
  return `#!/usr/bin/env node
import {appendFileSync} from "node:fs"

appendFileSync(process.env.COMMAND_LOG, \`${commandName} \${process.argv.slice(2).join(" ")}\\n\`)
`
}

/**
 * Builds a fake git command that records invocations, lists GIT_TAGS and rejects
 * adding a missing package lock.
 * @returns {string} The executable script contents.
 */
function fakeGitScript() {
  return `#!/usr/bin/env node
import {appendFileSync, existsSync} from "node:fs"
import {join} from "node:path"

const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, \`git \${args.join(" ")}\\n\`)

if (args[0] === "tag" && (args.includes("--list") || args.includes("-l"))) {
  const tags = (process.env.GIT_TAGS ?? "").split("\\n").filter(Boolean)
  if (tags.length > 0) process.stdout.write(tags.join("\\n") + "\\n")
  process.exit(0)
}

if (args[0] === "add" && args.includes("package-lock.json") && !existsSync(join(process.cwd(), "package-lock.json"))) {
  process.exit(1)
}
`
}

/**
 * Finds the single `npm version <x>` command in the log.
 * @param {string[]} commands The command lines invoked by the CLI.
 * @returns {string} The npm version command line.
 */
function versionCommand(commands) {
  const command = commands.find((line) => line.startsWith("npm version "))

  assert.ok(command, "expected an npm version command")

  return command
}

/**
 * Runs the CLI expecting it to fail and returns the captured stderr.
 * @param {{name?: string, version?: string, scripts: Record<string, string>}} packageJson The package manifest to write.
 * @param {{packageLock?: boolean, shrinkwrap?: boolean, tags?: string[]}} [options] Additional package fixture options.
 * @returns {string} The failing process's stderr (falling back to stdout or message).
 */
function runReleasePatchFailure(packageJson, options = {}) {
  /** @type {(Error & {stderr?: string}) | undefined} */
  let failure

  try {
    runReleasePatch(packageJson, options)
  } catch (error) {
    failure = /** @type {Error & {stderr?: string}} */ (error)
  }

  assert.ok(failure, "expected release-patch to fail but it succeeded")

  // execFileSync surfaces the child's stderr (where the CLI prints its error) as a Buffer; String() normalizes it.
  return String(failure.stderr ?? failure.message)
}

/**
 * Finds the single `git push` command in the log.
 * @param {string[]} commands The command lines invoked by the CLI.
 * @returns {string} The git push command line.
 */
function pushCommand(commands) {
  const command = commands.find((line) => line.startsWith("git push"))

  assert.ok(command, "expected a git push command")

  return command
}

/** @param {string[]} commands The command lines invoked by the CLI. */
function assertSingleExplicitBuildAfterVersion(commands) {
  assert.deepEqual(commands.filter((command) => command === "npm run build"), ["npm run build"])
  assert.ok(commands.indexOf(versionCommand(commands)) < commands.indexOf("npm run build"))
}

test("defines a self-release script that runs the local CLI", () => {
  assert.equal(projectPackageJson.scripts["release:patch"], "node bin/release-patch.js")
})

test("runs an explicit build when only publish lifecycle scripts build", () => {
  const commands = runReleasePatch(
    {
      scripts: {
        build: "tsc",
        prepare: "npm run build",
        prepublishOnly: "npm run clean && npm run build"
      }
    },
    {packageLock: true}
  )

  assert.deepEqual(commands.filter((command) => command === "npm run build"), ["npm run build"])
  assert.ok(commands.indexOf("npm run build") < commands.indexOf(pushCommand(commands)))
})

test("does not run an explicit build when version lifecycle scripts build", () => {
  const commands = runReleasePatch(
    {
      scripts: {
        build: "tsc",
        version: "npm run build"
      }
    },
    {packageLock: true}
  )

  assert.equal(commands.includes("npm run build"), false)
})

test("installs dependencies after syncing master and before versioning", () => {
  const commands = runReleasePatch(
    {
      scripts: {}
    },
    {packageLock: true}
  )

  assert.deepEqual(commands.filter((command) => command === "npm install"), ["npm install"])
  assert.ok(commands.indexOf("git merge origin/master") < commands.indexOf("npm install"))
  assert.ok(commands.indexOf("npm install") < commands.indexOf(versionCommand(commands)))
})

test("runs normal install when npm shrinkwrap exists", () => {
  const commands = runReleasePatch(
    {
      scripts: {}
    },
    {shrinkwrap: true}
  )

  assert.deepEqual(commands.filter((command) => command === "npm install"), ["npm install"])
  assert.equal(commands.includes("npm install --no-package-lock"), false)
})

test("runs one explicit build after bumping the version when no release lifecycle script builds", () => {
  const commands = runReleasePatch(
    {
      scripts: {
        build: "tsc"
      }
    },
    {packageLock: true}
  )

  assertSingleExplicitBuildAfterVersion(commands)
})

test("runs an explicit build when only preversion builds", () => {
  const commands = runReleasePatch(
    {
      scripts: {
        build: "tsc",
        preversion: "npm run build"
      }
    },
    {packageLock: true}
  )

  assertSingleExplicitBuildAfterVersion(commands)
})

test("does not require a package lock when none exists", () => {
  const commands = runReleasePatch({scripts: {}})

  assert.ok(commands.includes("npm install --no-package-lock"))
  assert.equal(commands.includes("git add package.json package-lock.json"), false)
  assert.ok(commands.includes("git add package.json"))
})

test("fetches tags from origin before calculating the next version", () => {
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v1.0.1"]})

  assert.ok(commands.includes("git fetch origin --tags"))
  assert.ok(commands.indexOf("git fetch origin --tags") < commands.indexOf(versionCommand(commands)))
})

test("derives the next patch version from the latest git tag and ignores package.json", () => {
  const commands = runReleasePatch(
    {version: "9.9.9", scripts: {}},
    {packageLock: true, tags: ["v1.2.3", "v1.2.5", "v1.1.9", "v1.2.4"]}
  )

  assert.ok(commands.includes("npm version 1.2.6 --no-git-tag-version"))
  assert.equal(commands.some((command) => command.startsWith("npm version 9.9.")), false)
})

test("never derives the version from npm's implicit patch keyword", () => {
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v2.0.0"]})

  assert.equal(commands.some((command) => command.startsWith("npm version patch")), false)
})

test("uses the derived version when updating package.json without creating a git tag", () => {
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v2.0.0"]})

  assert.ok(commands.includes("npm version 2.0.1 --no-git-tag-version"))
})

test("creates an annotated tag on the release commit after committing", () => {
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v2.0.0"]})

  const commitIndex = commands.findIndex((command) => command.startsWith("git commit"))
  const tagIndex = commands.indexOf("git tag -a v2.0.1 -m v2.0.1")

  assert.ok(tagIndex >= 0, "expected an annotated tag command")
  assert.ok(commitIndex >= 0, "expected a commit command")
  assert.ok(commitIndex < tagIndex, "the tag must be created after the release commit")
})

test("pushes the release commit and exact tag atomically in a single non-force push", () => {
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v2.0.0"]})

  const tagIndex = commands.indexOf("git tag -a v2.0.1 -m v2.0.1")
  const pushes = commands.filter((command) => command.startsWith("git push"))

  // A single atomic push publishes the branch and its release tag together, so the branch is
  // never pushed without its tag if a second push were to fail.
  assert.deepEqual(pushes, ["git push --atomic origin master v2.0.1"])
  assert.ok(tagIndex >= 0, "expected an annotated tag command")
  assert.ok(tagIndex < commands.indexOf("git push --atomic origin master v2.0.1"), "the tag must exist before pushing")
  assert.equal(commands.some((command) => /(?:^|\s)(?:--force|-f|--force-with-lease)(?:\s|$)/u.test(command)), false)
})

test("publishes and then verifies the exact published version from the registry", () => {
  const commands = runReleasePatch({name: "my-pkg", scripts: {}}, {packageLock: true, tags: ["v2.0.0"]})

  const publishIndex = commands.indexOf("npm publish")
  const viewIndex = commands.indexOf("npm view my-pkg@2.0.1 version")

  assert.ok(publishIndex >= 0, "expected an npm publish")
  assert.ok(viewIndex >= 0, "expected an exact registry version lookup")
  assert.ok(publishIndex < viewIndex, "verification must run after publishing")
})

test("fails with an actionable message when no valid release tag exists", () => {
  const stderr = runReleasePatchFailure({scripts: {}}, {packageLock: true, tags: []})

  assert.match(stderr, /could not find a valid vX\.Y\.Z release tag/u)
  assert.match(stderr, /git tag -a v0\.0\.0 -m v0\.0\.0/u)
})

test("fails with an actionable message when only malformed or non-semver tags exist", () => {
  const stderr = runReleasePatchFailure(
    {scripts: {}},
    {packageLock: true, tags: ["banana", "v1.2", "1.2.3", "vX.Y.Z", "v1.2.3-rc.1"]}
  )

  assert.match(stderr, /could not find a valid vX\.Y\.Z release tag/u)
})

test("rejects leading-zero version components instead of canonicalizing them", () => {
  // "v01.9.9" must not be treated as 1.9.9 (which would derive 1.9.10); the only valid tag is v1.0.0.
  const commands = runReleasePatch({scripts: {}}, {packageLock: true, tags: ["v1.0.0", "v01.9.9", "v1.00.0"]})

  assert.ok(commands.includes("npm version 1.0.1 --no-git-tag-version"))
  assert.equal(commands.some((command) => command.startsWith("npm version 1.9.")), false)
})

test("fails when the only tags carry leading-zero components", () => {
  const stderr = runReleasePatchFailure({scripts: {}}, {packageLock: true, tags: ["v01.2.3", "v1.02.3", "v1.2.03"]})

  assert.match(stderr, /could not find a valid vX\.Y\.Z release tag/u)
})

test("fails clearly when the latest tag's version component exceeds the safe integer range", () => {
  const stderr = runReleasePatchFailure({scripts: {}}, {packageLock: true, tags: ["v1.0.9007199254740993"]})

  assert.match(stderr, /safe integer/u)
})

test("fails clearly when the latest patch is at the safe integer limit and cannot be incremented", () => {
  const stderr = runReleasePatchFailure({scripts: {}}, {packageLock: true, tags: ["v1.0.9007199254740991"]})

  assert.match(stderr, /safe integer/u)
})

test("does not let a malicious package name inject shell commands during registry verification", () => {
  const markerDir = mkdtempSync(join(tmpdir(), "release-patch-marker-"))
  const marker = join(markerDir, "pwned")

  try {
    const commands = runReleasePatch(
      {name: `evil-$(touch ${marker})`, scripts: {}},
      {packageLock: true, tags: ["v1.0.0"]}
    )

    assert.equal(existsSync(marker), false, "a malicious package name must not execute injected shell commands")
    assert.ok(commands.includes("npm publish"), "the release should still complete for a hostile name")
  } finally {
    rmSync(markerDir, {force: true, recursive: true})
  }
})
