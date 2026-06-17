import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join, resolve} from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDirectory, "..")
const releasePatchBin = join(projectRoot, "bin/release-patch.js")

/**
 * Runs the CLI with fake npm and git commands and returns the command log.
 * @param {{scripts: Record<string, string>}} packageJson The package manifest to write.
 * @param {{packageLock?: boolean}} [options] Additional package fixture options.
 * @returns {string[]} The command lines invoked by the CLI.
 */
function runReleasePatch(packageJson, options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "release-patch-test-"))

  try {
    const fakeBin = join(workspace, "bin")
    const packageRoot = join(workspace, "package")
    const commandLog = join(workspace, "commands.log")

    mkdirSync(fakeBin)
    mkdirSync(packageRoot)
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(packageJson, null, 2))
    if (options.packageLock) {
      writeFileSync(join(packageRoot, "package-lock.json"), "{}\n")
    }
    writeExecutable(join(fakeBin, "npm"), fakeCommandScript("npm"))
    writeExecutable(join(fakeBin, "git"), fakeGitScript())

    execFileSync(process.execPath, [releasePatchBin], {
      cwd: packageRoot,
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
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
 * Builds a fake git command that rejects adding a missing package lock.
 * @returns {string} The executable script contents.
 */
function fakeGitScript() {
  return `#!/usr/bin/env node
import {appendFileSync, existsSync} from "node:fs"
import {join} from "node:path"

const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, \`git \${args.join(" ")}\\n\`)

if (args[0] === "add" && args.includes("package-lock.json") && !existsSync(join(process.cwd(), "package-lock.json"))) {
  process.exit(1)
}
`
}

/** @param {string[]} commands The command lines invoked by the CLI. */
function assertSingleExplicitBuildAfterVersion(commands) {
  assert.deepEqual(commands.filter((command) => command === "npm run build"), ["npm run build"])
  assert.ok(commands.indexOf("npm version patch --no-git-tag-version") < commands.indexOf("npm run build"))
}

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
  assert.ok(commands.indexOf("npm run build") < commands.indexOf("git push origin master"))
  assert.equal(commands.includes("npm install"), false)
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
  assert.equal(commands.includes("npm install"), false)
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

  assert.equal(commands.includes("git add package.json package-lock.json"), false)
  assert.ok(commands.includes("git add package.json"))
})
