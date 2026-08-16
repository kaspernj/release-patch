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

// The version manifests npm's bump touches and that the release commit is expected to carry.
const versionManifestFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json"]

/**
 * @typedef {object} ScenarioOptions
 * @property {string | null} [name] The package name (null omits it; defaults to "fixture-package").
 * @property {string} [version] The package.json version field (defaults to "0.0.0").
 * @property {boolean} [private] Whether the manifest is marked private.
 * @property {Record<string, string>} [scripts] The package scripts (defaults to none).
 * @property {boolean} [packageLock] Whether to create a package-lock.json fixture.
 * @property {boolean} [shrinkwrap] Whether to create an npm-shrinkwrap.json fixture.
 * @property {string[]} [annotatedTags] Annotated tags to create (and normally push) at HEAD.
 * @property {string[]} [lightweightTags] Lightweight tags to create (and normally push) at HEAD.
 * @property {string[]} [published] Registry seed as `name@version` specs (defaults to the latest annotated tag).
 * @property {boolean} [pushTags] Whether to push the created tags to origin (defaults to true).
 * @property {boolean} [extraCommit] Whether to add and push a commit after tagging so the latest tag is not at HEAD.
 * @property {string} [gitignore] The .gitignore contents (defaults to ignoring node_modules).
 */

/**
 * @typedef {object} ScenarioContext
 * @property {string} workspace The temporary workspace root.
 * @property {string} work The real Git work repository the CLI runs in.
 * @property {string} origin The bare Git origin the work repo pushes to.
 * @property {string} fakeBin The directory holding the fake npm and logging git shim.
 * @property {string} commandLog The path the fake commands append their invocations to.
 * @property {string} registryFile The JSON file backing the fake npm registry.
 * @property {string} visibilityStateFile State used to simulate delayed registry propagation.
 * @property {string} realGit The absolute path to the real git binary.
 */

/**
 * Resolves the real git binary from PATH before any fake bin shadows it.
 * @returns {string} The absolute path to the real git executable.
 */
function realGitPath() {
  const directories = (process.env.PATH ?? "").split(":")
  const gitPath = directories.map((directory) => join(directory, "git")).find((candidate) => existsSync(candidate))

  if (gitPath === undefined) throw new Error("could not locate the real git binary on PATH")

  return gitPath
}

const realGit = realGitPath()

/**
 * Runs the real git binary and returns its stdout.
 * @param {string} cwd The working directory to run git in.
 * @param {string[]} args The git arguments.
 * @returns {string} The command stdout.
 */
function git(cwd, args) {
  return execFileSync(realGit, args, {cwd, encoding: "utf8"})
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
 * Builds a fake npm that records every invocation, updates the version manifests on `npm version`,
 * drives a file-backed fake registry for `view`/`publish`, and can be steered to fail its dry-run,
 * publish, or a specific version lookup — so a release runs end to end without a real registry.
 * @returns {string} The executable script contents.
 */
function fakeNpmScript() {
  return `#!/usr/bin/env node
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"

const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, "npm " + args.join(" ") + "\\n")

function readRegistry() {
  if (!existsSync(process.env.REGISTRY_FILE)) return []
  return JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"))
}

function writeRegistry(list) {
  writeFileSync(process.env.REGISTRY_FILE, JSON.stringify(list))
}

function specVersion(spec) {
  return spec.slice(spec.lastIndexOf("@") + 1)
}

const command = args[0]

if (command === "whoami") {
  process.exit(process.env.NPM_WHOAMI_FAIL === "1" ? 1 : 0)
}

if (command === "login") {
  process.exit(0)
}

if (command === "install") {
  if (process.env.INSTALL_STRAY_FILE) writeFileSync(join(process.cwd(), process.env.INSTALL_STRAY_FILE), "stray\\n")
  if (process.env.INSTALL_TRACKED_FILE) writeFileSync(join(process.cwd(), process.env.INSTALL_TRACKED_FILE), "mutated by install\\n")
  if (process.env.INSTALL_LOCKFILE) writeFileSync(join(process.cwd(), "package-lock.json"), JSON.stringify({name: "generated", version: "0.0.0"}) + "\\n")
  process.exit(0)
}

if (command === "run" && args[1] === "build") {
  if (process.env.BUILD_FAIL === "1") process.exit(1)
  if (process.env.BUILD_STRAY_FILE) writeFileSync(join(process.cwd(), process.env.BUILD_STRAY_FILE), "stray\\n")
  if (process.env.BUILD_IGNORED_FILE) writeFileSync(join(process.cwd(), process.env.BUILD_IGNORED_FILE), "ignored\\n")
  if (process.env.BUILD_TRACKED_FILE) writeFileSync(join(process.cwd(), process.env.BUILD_TRACKED_FILE), "mutated by build\\n")
  process.exit(0)
}

if (command === "version") {
  if (process.env.NPM_VERSION_FAIL === "1") process.exit(1)
  const nextVersion = args[1]
  for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
    const path = join(process.cwd(), file)
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    manifest.version = nextVersion
    if (manifest.packages && manifest.packages[""]) manifest.packages[""].version = nextVersion
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\\n")
  }
  process.exit(0)
}

if (command === "publish") {
  if (args.includes("--dry-run")) {
    if (process.env.NPM_DRYRUN_FAIL === "1") {
      process.stderr.write("npm error the publish dry-run failed\\n")
      process.exit(1)
    }
    if (process.env.DRYRUN_STRAY_FILE) writeFileSync(join(process.cwd(), process.env.DRYRUN_STRAY_FILE), "stray\\n")
    if (process.env.DRYRUN_TRACKED_FILE) writeFileSync(join(process.cwd(), process.env.DRYRUN_TRACKED_FILE), "mutated by dry-run\\n")
    process.exit(0)
  }
  if (process.env.NPM_PUBLISH_FAIL === "1") {
    process.stderr.write("npm error code E500\\nnpm error the publish failed\\n")
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"))
  const spec = manifest.name + "@" + manifest.version
  const registry = readRegistry()
  if (!registry.includes(spec)) registry.push(spec)
  writeRegistry(registry)
  if (process.env.NPM_VISIBILITY_MISSES) {
    writeFileSync(process.env.NPM_VISIBILITY_STATE_FILE, JSON.stringify({spec, misses: 0}))
  }
  process.exit(0)
}

if (command === "view") {
  const spec = args[1]
  if (args.slice(2).join(" ") === "version gitHead --json" && process.env.NPM_METADATA_VERSION) {
    process.stdout.write(JSON.stringify({version: process.env.NPM_METADATA_VERSION, gitHead: process.env.NPM_METADATA_GIT_HEAD}) + "\\n")
    process.exit(0)
  }
  const errorVersion = process.env.NPM_VIEW_ERROR_VERSION
  if (errorVersion && spec.endsWith("@" + errorVersion)) {
    process.stderr.write((process.env.NPM_VIEW_ERROR_STDERR || "") + "\\n")
    process.exit(Number(process.env.NPM_VIEW_ERROR_EXIT || "1"))
  }
  if (process.env.NPM_VISIBILITY_MISSES && existsSync(process.env.NPM_VISIBILITY_STATE_FILE)) {
    const visibility = JSON.parse(readFileSync(process.env.NPM_VISIBILITY_STATE_FILE, "utf8"))
    if (visibility.spec === spec && visibility.misses < Number(process.env.NPM_VISIBILITY_MISSES)) {
      visibility.misses += 1
      writeFileSync(process.env.NPM_VISIBILITY_STATE_FILE, JSON.stringify(visibility))
      process.stderr.write("npm error code E404\\nnpm error 404 registry propagation pending\\n")
      process.exit(1)
    }
    if (process.env.NPM_VISIBILITY_ERROR_AFTER_MISSES) {
      process.stderr.write("npm error code EAI_AGAIN\\nnpm error network registry lookup failed\\n")
      process.exit(1)
    }
  }
  const registry = readRegistry()
  if (registry.includes(spec)) {
    process.stdout.write(specVersion(spec) + "\\n")
    process.exit(0)
  }
  process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET registry - " + spec + " is not in the registry.\\n")
  process.exit(1)
}

process.exit(0)
`
}

/**
 * Builds a git shim that records every invocation and then delegates to the real git binary, so the
 * suite gets a full command log while every branch, tag, commit and push is genuine.
 * @returns {string} The executable script contents.
 */
function fakeGitScript() {
  return `#!/usr/bin/env node
import {execFileSync} from "node:child_process"
import {appendFileSync} from "node:fs"

const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_LOG, "git " + args.join(" ") + "\\n")

try {
  if (process.env.GIT_ATOMIC_PUSH_FAIL === "1" && args[0] === "push" && args.includes("--atomic")) process.exit(1)
  execFileSync(process.env.REAL_GIT, args, {stdio: "inherit"})
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1)
}
`
}

/**
 * Builds a fake sleep command so visibility retry tests complete without wall-clock delays.
 * @returns {string} The executable script contents.
 */
function fakeSleepScript() {
  return `#!/usr/bin/env node
import {appendFileSync} from "node:fs"

appendFileSync(process.env.COMMAND_LOG, "sleep " + process.argv.slice(2).join(" ") + "\\n")
`
}

/**
 * Applies the fixture package name to a manifest (omitting it entirely for the missing-name case).
 * @param {Record<string, unknown>} manifest The manifest under construction.
 * @param {ScenarioOptions} options The scenario options.
 */
function applyManifestName(manifest, options) {
  if (!("name" in options)) {
    manifest.name = "fixture-package"

    return
  }

  if (options.name !== null && options.name !== undefined) manifest.name = options.name
}

/**
 * Builds the fixture manifest.
 * @param {ScenarioOptions} options The scenario options.
 * @returns {Record<string, unknown>} The manifest to write.
 */
function buildManifest(options) {
  /** @type {Record<string, unknown>} */
  const manifest = {version: options.version ?? "0.0.0", scripts: options.scripts ?? {}}

  applyManifestName(manifest, options)
  if (options.private !== undefined) manifest.private = options.private

  return manifest
}

/**
 * Writes the fixture manifest.
 * @param {string} work The work repository path.
 * @param {ScenarioOptions} options The scenario options.
 */
function writeManifest(work, options) {
  writeFileSync(join(work, "package.json"), JSON.stringify(buildManifest(options), null, 2) + "\n")
}

/**
 * Writes the optional lockfiles that steer the install path and the release commit contents.
 * @param {string} work The work repository path.
 * @param {ScenarioOptions} options The scenario options.
 */
function writeLockfiles(work, options) {
  if (options.packageLock) writeFileSync(join(work, "package-lock.json"), "{}\n")
  if (options.shrinkwrap) writeFileSync(join(work, "npm-shrinkwrap.json"), "{}\n")
}

/**
 * Extracts the `X.Y.Z` version from an exact stable release tag, or null for anything else.
 * @param {string} tag The tag name.
 * @returns {string | null} The version string, or null when the tag is not an exact release tag.
 */
function seedVersion(tag) {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag) ? tag.slice(1) : null
}

/**
 * Derives the default registry seed: every valid annotated tag is treated as already published, so a
 * normal release finds its baseline published and the derived next patch absent.
 * @param {string | null | undefined} name The package name.
 * @param {string[]} annotatedTags The annotated tags.
 * @returns {string[]} The `name@version` specs to seed.
 */
function autoSeedPublished(name, annotatedTags) {
  const packageName = name ?? "fixture-package"
  const specs = []

  for (const tag of annotatedTags) {
    const version = seedVersion(tag)

    if (version !== null) specs.push(`${packageName}@${version}`)
  }

  return specs
}

/**
 * Creates the temporary workspace and returns its paths.
 * @returns {Omit<ScenarioContext, "realGit">} The workspace paths.
 */
function createWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "release-patch-int-"))
  const paths = {
    workspace,
    work: join(workspace, "work"),
    origin: join(workspace, "origin.git"),
    fakeBin: join(workspace, "bin"),
    commandLog: join(workspace, "commands.log"),
    registryFile: join(workspace, "registry.json"),
    visibilityStateFile: join(workspace, "visibility.json")
  }

  mkdirSync(paths.work)
  mkdirSync(paths.fakeBin)

  return paths
}

/**
 * Writes the fake npm and logging git shim into the workspace bin directory.
 * @param {string} fakeBin The fake bin directory.
 */
function writeFakeBins(fakeBin) {
  writeExecutable(join(fakeBin, "npm"), fakeNpmScript())
  writeExecutable(join(fakeBin, "git"), fakeGitScript())
  writeExecutable(join(fakeBin, "sleep"), fakeSleepScript())
}

/**
 * Initializes the bare origin and the work repo, configuring a deterministic committer identity.
 * @param {Omit<ScenarioContext, "realGit">} paths The workspace paths.
 */
function initRepositories(paths) {
  git(paths.workspace, ["init", "--bare", "--initial-branch=master", paths.origin])
  git(paths.workspace, ["init", "--initial-branch=master", paths.work])
  git(paths.work, ["config", "user.email", "release-patch-test@example.com"])
  git(paths.work, ["config", "user.name", "release-patch-test"])
  git(paths.work, ["config", "commit.gpgsign", "false"])
  git(paths.work, ["config", "tag.gpgsign", "false"])
}

/**
 * Writes the fixture files, records the initial commit and pushes master to origin.
 * @param {string} work The work repository path.
 * @param {string} origin The bare origin path.
 * @param {ScenarioOptions} options The scenario options.
 */
function commitFixture(work, origin, options) {
  writeManifest(work, options)
  writeFileSync(join(work, ".gitignore"), options.gitignore ?? "node_modules\n")
  writeLockfiles(work, options)
  git(work, ["add", "-A"])
  git(work, ["commit", "-m", "init"])
  git(work, ["remote", "add", "origin", origin])
  git(work, ["push", "-u", "origin", "master"])
}

/**
 * Creates the annotated and lightweight tags at the current HEAD.
 * @param {string} work The work repository path.
 * @param {string[]} annotatedTags The annotated tags to create.
 * @param {string[]} lightweightTags The lightweight tags to create.
 */
function tagCommits(work, annotatedTags, lightweightTags) {
  for (const tag of annotatedTags) git(work, ["tag", "-a", tag, "-m", tag])
  for (const tag of lightweightTags) git(work, ["tag", tag])
}

/**
 * Adds and pushes a commit after tagging so the latest tag is no longer at HEAD.
 * @param {string} work The work repository path.
 * @param {ScenarioOptions} options The scenario options.
 */
function addLaterCommitIfRequested(work, options) {
  if (!options.extraCommit) return

  git(work, ["commit", "--allow-empty", "-m", "later work"])
  git(work, ["push", "origin", "master"])
}

/**
 * Pushes the created tags to origin unless the scenario opts out.
 * @param {string} work The work repository path.
 * @param {ScenarioOptions} options The scenario options.
 * @param {string[]} annotatedTags The annotated tags.
 * @param {string[]} lightweightTags The lightweight tags.
 */
function pushTagsIfRequested(work, options, annotatedTags, lightweightTags) {
  if ((options.pushTags ?? true) && annotatedTags.length + lightweightTags.length > 0) {
    git(work, ["push", "origin", "--tags"])
  }
}

/**
 * Seeds the fake registry, defaulting to treating the latest annotated tag as published.
 * @param {string} registryFile The registry JSON path.
 * @param {ScenarioOptions} options The scenario options.
 * @param {string[]} annotatedTags The annotated tags.
 */
function seedRegistry(registryFile, options, annotatedTags) {
  const published = options.published ?? autoSeedPublished(options.name, annotatedTags)

  writeFileSync(registryFile, JSON.stringify(published))
}

/**
 * Sets up a real temporary Git work repo wired to a bare origin, plus the fake npm and logging git
 * shim and a seeded fake registry, so a release can be exercised end to end and inspected afterwards.
 * @param {ScenarioOptions} [options] The scenario options.
 * @returns {ScenarioContext} The scenario context.
 */
function setupRelease(options = {}) {
  const annotatedTags = options.annotatedTags ?? []
  const lightweightTags = options.lightweightTags ?? []
  const paths = createWorkspace()

  writeFakeBins(paths.fakeBin)
  initRepositories(paths)
  commitFixture(paths.work, paths.origin, options)
  tagCommits(paths.work, annotatedTags, lightweightTags)
  addLaterCommitIfRequested(paths.work, options)
  pushTagsIfRequested(paths.work, options, annotatedTags, lightweightTags)
  seedRegistry(paths.registryFile, options, annotatedTags)

  return {...paths, realGit}
}

/**
 * Sets up a scenario, runs the body against it, and always cleans up the workspace afterwards.
 * @param {ScenarioOptions} options The scenario options.
 * @param {(context: ScenarioContext) => void} body The test body.
 */
function withRelease(options, body) {
  const context = setupRelease(options)

  try {
    body(context)
  } finally {
    rmSync(context.workspace, {force: true, recursive: true})
  }
}

/**
 * Normalizes a failed CLI invocation into the same shape as a successful one.
 * @param {unknown} error The error execFileSync threw.
 * @returns {{failure: Error & {status?: number}, stdout: string, stderr: string, output: string}} The run result.
 */
function failureResult(error) {
  const failure = /** @type {Error & {status?: number, stdout?: string, stderr?: string}} */ (error)
  const stdout = String(failure.stdout ?? "")
  const stderr = String(failure.stderr ?? "")

  return {failure, stdout, stderr, output: `${stdout}${stderr}`}
}

/**
 * Runs the release CLI in the scenario's work repo with the fake npm and logging git shim on PATH.
 * @param {ScenarioContext} context The scenario context.
 * @param {{resume?: boolean, args?: string[], env?: Record<string, string>}} [runOptions] The run controls.
 * @returns {{failure?: Error & {status?: number}, stdout: string, stderr: string, output: string}} The run result.
 */
function runCli(context, runOptions = {}) {
  const argv = runOptions.args ?? (runOptions.resume ? ["--resume"] : [])
  const env = {
    ...process.env,
    PATH: `${context.fakeBin}:${process.env.PATH}`,
    COMMAND_LOG: context.commandLog,
    REGISTRY_FILE: context.registryFile,
    NPM_VISIBILITY_STATE_FILE: context.visibilityStateFile,
    REAL_GIT: context.realGit,
    ...runOptions.env
  }

  try {
    const stdout = execFileSync(process.execPath, [releasePatchBin, ...argv], {cwd: context.work, env, encoding: "utf8", stdio: "pipe"})

    return {failure: undefined, stdout, stderr: "", output: stdout}
  } catch (error) {
    return failureResult(error)
  }
}

/**
 * Reads the recorded command log.
 * @param {ScenarioContext} context The scenario context.
 * @returns {string[]} The recorded command lines.
 */
function commandsOf(context) {
  if (!existsSync(context.commandLog)) return []

  return readFileSync(context.commandLog, "utf8").trim().split("\n").filter(Boolean)
}

/**
 * Truncates the command log so a follow-up run can be inspected in isolation.
 * @param {ScenarioContext} context The scenario context.
 */
function clearCommands(context) {
  writeFileSync(context.commandLog, "")
}

/**
 * Reads the fake registry's published specs.
 * @param {ScenarioContext} context The scenario context.
 * @returns {string[]} The published `name@version` specs.
 */
function registryOf(context) {
  return JSON.parse(readFileSync(context.registryFile, "utf8"))
}

/**
 * Runs a release expected to succeed and returns the recorded command log.
 * @param {ScenarioContext} context The scenario context.
 * @param {{resume?: boolean, args?: string[], env?: Record<string, string>}} [runOptions] The run controls.
 * @returns {string[]} The recorded command lines.
 */
function release(context, runOptions = {}) {
  const result = runCli(context, runOptions)

  assert.equal(result.failure, undefined, `expected the release to succeed:\n${result.output}`)

  return commandsOf(context)
}

/**
 * Runs a release expected to be blocked, asserting it matched a message and mutated nothing.
 * @param {ScenarioContext} context The scenario context.
 * @param {RegExp} pattern The message the failure must match.
 * @param {{resume?: boolean, args?: string[], env?: Record<string, string>}} [runOptions] The run controls.
 * @returns {string} The failing output.
 */
function assertBlocked(context, pattern, runOptions = {}) {
  const {failure, output} = runCli(context, runOptions)

  assert.ok(failure, "expected the release to be blocked")
  assert.match(output, pattern)
  assertNoReleaseMutations(commandsOf(context))

  return output
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
 * Finds the single atomic `git push` command in the log.
 * @param {string[]} commands The command lines invoked by the CLI.
 * @returns {string} The git push command line.
 */
function pushCommand(commands) {
  const command = commands.find((line) => line.startsWith("git push --atomic"))

  assert.ok(command, "expected a git push command")

  return command
}

// A release "mutation" is any command that writes the version, records the release commit/tag, or
// pushes/publishes it. `git tag -a` (not the read-only enumeration) and `npm publish` (including its
// `--dry-run` gate) both count, so nothing irreversible may run before the preflights succeed.
const releaseMutationPrefixes = ["npm version ", "git commit", "git tag -a", "git push", "npm publish"]

/**
 * Reports whether a recorded command is a release-producing mutation.
 * @param {string} command A single recorded command line.
 * @returns {boolean} Whether the command mutates release state.
 */
function isReleaseMutation(command) {
  return releaseMutationPrefixes.some((prefix) => command.startsWith(prefix))
}

/**
 * Asserts that no release-producing mutation ran (used when a preflight must abort before side effects).
 * @param {string[]} commands The command lines invoked by the CLI.
 */
function assertNoReleaseMutations(commands) {
  const mutation = commands.find(isReleaseMutation)

  assert.equal(mutation, undefined, `no release mutation may run before the preflights succeed, saw: ${mutation}`)
}

/**
 * Asserts a single explicit build ran, after the version bump.
 * @param {string[]} commands The command lines invoked by the CLI.
 */
function assertSingleExplicitBuildAfterVersion(commands) {
  assertRanOnce(commands, "npm run build")
  assert.ok(commands.indexOf(versionCommand(commands)) < commands.indexOf("npm run build"))
}

/**
 * Reports whether the CLI recorded any command with the given prefix.
 * @param {string[]} commands The command lines invoked by the CLI.
 * @param {string} prefix The command prefix to search for.
 * @returns {boolean} Whether a matching command exists.
 */
function ranCommand(commands, prefix) {
  return commands.some((command) => command.startsWith(prefix))
}

/**
 * Asserts a command ran exactly once.
 * @param {string[]} commands The command lines invoked by the CLI.
 * @param {string} command The exact command that must appear once.
 */
function assertRanOnce(commands, command) {
  assert.deepEqual(commands.filter((line) => line === command), [command])
}

/**
 * Lists the files touched by a commit.
 * @param {ScenarioContext} context The scenario context.
 * @param {string} ref The commit-ish to inspect.
 * @returns {string[]} The changed file paths.
 */
function committedFiles(context, ref) {
  return git(context.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", ref]).trim().split("\n").filter(Boolean)
}

/**
 * Resolves a commit-ish to a SHA in the given repo.
 * @param {string} cwd The repository path.
 * @param {string} ref The commit-ish.
 * @returns {string} The resolved SHA.
 */
function revParse(cwd, ref) {
  return git(cwd, ["rev-parse", ref]).trim()
}

test("defines a self-release script that runs the local CLI", () => {
  assert.equal(projectPackageJson.scripts["release:patch"], "node bin/release-patch.js")
})

test("runs an explicit build when only publish lifecycle scripts build", () => {
  withRelease({
    scripts: {build: "tsc", prepare: "npm run build", prepublishOnly: "npm run clean && npm run build"},
    packageLock: true,
    annotatedTags: ["v1.0.0"]
  }, (context) => {
    const commands = release(context)

    assertRanOnce(commands, "npm run build")
    assert.ok(commands.indexOf("npm run build") < commands.indexOf(pushCommand(commands)))
  })
})

test("does not run an explicit build when version lifecycle scripts build", () => {
  withRelease({scripts: {build: "tsc", version: "npm run build"}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assert.equal(release(context).includes("npm run build"), false)
  })
})

test("installs dependencies after syncing master and before versioning", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    const commands = release(context)

    assertRanOnce(commands, "npm install")
    assert.ok(commands.indexOf("git merge --ff-only origin/master") < commands.indexOf("npm install"))
    assert.ok(commands.indexOf("npm install") < commands.indexOf(versionCommand(commands)))
  })
})

test("runs normal install when npm shrinkwrap exists", () => {
  withRelease({scripts: {}, shrinkwrap: true, annotatedTags: ["v1.0.0"]}, (context) => {
    const commands = release(context)

    assertRanOnce(commands, "npm install")
    assert.equal(commands.includes("npm install --no-package-lock"), false)
  })
})

test("runs one explicit build after bumping the version when no release lifecycle script builds", () => {
  withRelease({scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertSingleExplicitBuildAfterVersion(release(context))
  })
})

test("runs an explicit build when only preversion builds", () => {
  withRelease({scripts: {build: "tsc", preversion: "npm run build"}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertSingleExplicitBuildAfterVersion(release(context))
  })
})

test("does not require a package lock when none exists", () => {
  withRelease({scripts: {}, annotatedTags: ["v1.0.0"]}, (context) => {
    const commands = release(context)

    assert.ok(commands.includes("npm install --no-package-lock"))
    assert.ok(commands.includes("git add package.json"))
    assert.equal(commands.includes("git add package-lock.json"), false)
  })
})

test("fetches origin's authoritative tag set before calculating the next version", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.1"]}, (context) => {
    const commands = release(context)
    const fetch = "git fetch origin --tags --prune --prune-tags --force"

    assert.ok(commands.includes(fetch), "a normal release must sync tags authoritatively from origin")
    assert.ok(commands.indexOf(fetch) < commands.indexOf(versionCommand(commands)))
  })
})

test("a normal release treats origin as authoritative and ignores a stale local-only annotated tag", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    // A higher annotated tag that exists locally but was never pushed to origin must neither drive
    // nor block the next-version derivation; only origin's tag set is authoritative.
    git(context.work, ["tag", "-a", "v9.9.9", "-m", "v9.9.9"])

    const commands = release(context)

    assert.ok(commands.includes("npm version 1.0.1 --no-git-tag-version"), "must derive from origin's v1.0.0")
    assert.equal(ranCommand(commands, "npm version 9.9."), false, "the local-only v9.9.9 must never drive derivation")
    // The stale local-only tag is pruned during the sync so it can never poison a later derivation.
    assert.equal(git(context.work, ["tag", "-l", "v9.9.9"]).trim(), "", "origin is authoritative: the local-only tag is removed")
    assert.ok(registryOf(context).includes("fixture-package@1.0.1"))
  })
})

test("derives the next patch version from the latest annotated tag and ignores package.json", () => {
  withRelease({version: "9.9.9", scripts: {}, packageLock: true, annotatedTags: ["v1.2.3", "v1.2.5", "v1.1.9", "v1.2.4"]}, (context) => {
    const commands = release(context)

    assert.ok(commands.includes("npm version 1.2.6 --no-git-tag-version"))
    assert.equal(ranCommand(commands, "npm version 9.9."), false)
  })
})

test("never derives the version from npm's implicit patch keyword", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"]}, (context) => {
    assert.equal(ranCommand(release(context), "npm version patch"), false)
  })
})

test("uses the derived version when updating package.json without creating a git tag", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"]}, (context) => {
    assert.ok(release(context).includes("npm version 2.0.1 --no-git-tag-version"))
  })
})

test("ignores a higher lightweight tag and derives from the latest annotated tag", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], lightweightTags: ["v9.9.9"]}, (context) => {
    const commands = release(context)

    // The annotated v1.0.0 is authoritative even though a lightweight v9.9.9 sorts higher.
    assert.ok(commands.includes("npm version 1.0.1 --no-git-tag-version"))
    assert.equal(ranCommand(commands, "npm version 9.9."), false)
    assert.ok(registryOf(context).includes("fixture-package@1.0.1"))
  })
})

test("creates an annotated release tag that targets the exact release commit", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"]}, (context) => {
    const commands = release(context)
    const commitIndex = commands.findIndex((command) => command.startsWith("git commit"))
    const tagIndex = commands.indexOf("git tag -a v2.0.1 -m v2.0.1")

    assert.ok(commitIndex >= 0 && tagIndex >= 0, "expected a commit and an annotated tag")
    assert.ok(commitIndex < tagIndex, "the tag must be created after the release commit")

    // The created tag is a real annotated tag object pointing at the release commit (HEAD of master).
    assert.equal(git(context.work, ["cat-file", "-t", "v2.0.1"]).trim(), "tag")
    assert.equal(revParse(context.work, "v2.0.1^{commit}"), revParse(context.work, "HEAD"))
  })
})

test("pushes the release commit and exact tag atomically in a single non-force push", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"]}, (context) => {
    const commands = release(context)

    assert.deepEqual(commands.filter((command) => command.startsWith("git push --atomic")), ["git push --atomic origin master v2.0.1"])
    assert.ok(commands.indexOf("git tag -a v2.0.1 -m v2.0.1") < commands.indexOf("git push --atomic origin master v2.0.1"))
    // No push may force: the authoritative tag *fetch* uses --force to mirror origin, but a push never does.
    const pushes = commands.filter((command) => command.startsWith("git push"))

    assert.equal(pushes.some((command) => /(?:^|\s)(?:--force|-f|--force-with-lease)(?:\s|$)/u.test(command)), false)

    // The bare origin now carries the exact annotated tag on the pushed commit.
    assert.equal(git(context.origin, ["cat-file", "-t", "v2.0.1"]).trim(), "tag")
    assert.equal(revParse(context.origin, "v2.0.1^{commit}"), revParse(context.origin, "master"))
  })
})

test("publishes and then verifies the exact published version from the registry", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const commands = release(context)
    const publishIndex = commands.indexOf("npm publish")
    const verifyIndex = commands.lastIndexOf("npm view my-pkg@2.0.1 version")

    assert.ok(publishIndex >= 0 && verifyIndex >= 0, "expected a publish and an exact registry lookup")
    assert.ok(publishIndex < verifyIndex, "verification must run after publishing")
    assert.ok(registryOf(context).includes("my-pkg@2.0.1"))
  })
})

test("keeps checking with progress after the old ten-second registry visibility window", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const result = runCli(context, {env: {NPM_VISIBILITY_MISSES: "6"}})

    assert.equal(result.failure, undefined, `expected delayed visibility to succeed:\n${result.output}`)
    const commands = commandsOf(context)
    assert.equal(commands.filter((command) => command === "npm view my-pkg@2.0.1 version").length, 8)
    assert.deepEqual(commands.filter((command) => command.startsWith("sleep ")).slice(0, 6), [
      "sleep 1", "sleep 2", "sleep 4", "sleep 8", "sleep 15", "sleep 30"
    ])
    assert.match(result.stdout, /waiting for npm registry visibility .*attempt 6\/10.*30 seconds/u)
  })
})

test("bounds registry visibility retries and points genuinely unavailable releases to resume", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const {failure, output} = runCli(context, {env: {NPM_VISIBILITY_MISSES: "20"}})
    const commands = commandsOf(context)

    assert.ok(failure, "expected visibility verification to stop at its bounded limit")
    assert.equal(commands.filter((command) => command === "npm view my-pkg@2.0.1 version").length, 11)
    assert.deepEqual(commands.filter((command) => command.startsWith("sleep ")), [
      "sleep 1", "sleep 2", "sleep 4", "sleep 8", "sleep 15", "sleep 30", "sleep 30", "sleep 30", "sleep 30"
    ])
    assert.match(output, /did not become visible on npm after 10 attempts over 150 seconds/u)
    assert.match(output, /release-patch --resume/u)
  })
})

test("fails closed when a visibility retry changes from not-found to an ambiguous registry error", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const {failure, output} = runCli(context, {
      env: {NPM_VISIBILITY_MISSES: "1", NPM_VISIBILITY_ERROR_AFTER_MISSES: "1"}
    })
    const commands = commandsOf(context)

    assert.ok(failure, "an ambiguous registry failure must stop verification")
    assert.match(output, /could not determine whether my-pkg@2\.0\.1 is already published/u)
    assert.deepEqual(commands.filter((command) => command.startsWith("sleep ")), ["sleep 1"])
    assert.equal(commands.filter((command) => command === "npm view my-pkg@2.0.1 version").length, 3)
  })
})

test("commits package.json, the lockfile and the shrinkwrap together as the release commit", () => {
  withRelease({scripts: {}, packageLock: true, shrinkwrap: true, annotatedTags: ["v1.0.0"]}, (context) => {
    const commands = release(context)

    for (const file of versionManifestFiles) assert.ok(commands.includes(`git add ${file}`), `expected to stage ${file}`)

    assert.deepEqual([...committedFiles(context, "HEAD")].sort(), [...versionManifestFiles].sort())
    // The working tree is clean after the release: nothing stray leaked outside the intended commit.
    assert.equal(git(context.work, ["status", "--porcelain"]).trim(), "")
  })
})

test("runs a publish dry-run before the release commit and tag and the real publish after the push", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const commands = release(context)
    const dryRunIndex = commands.indexOf("npm publish --dry-run")
    const commitIndex = commands.findIndex((command) => command.startsWith("git commit"))
    const tagIndex = commands.indexOf("git tag -a v2.0.1 -m v2.0.1")
    const pushIndex = commands.indexOf("git push --atomic origin master v2.0.1")
    const publishIndex = commands.indexOf("npm publish")

    // The dry-run must precede the commit and tag so a failure leaves no local tag to poison derivation.
    assert.ok(dryRunIndex >= 0 && dryRunIndex < commitIndex, "the dry-run must gate the release commit")
    assert.ok(dryRunIndex < tagIndex, "the dry-run must gate the release tag")
    assert.ok(tagIndex < pushIndex, "the tag must exist before the push")
    assert.ok(pushIndex < publishIndex, "the real publish must run only after the push succeeds")
  })
})

test("synchronizes master with a fast-forward-only merge so no merge release commit is invented", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"]}, (context) => {
    const commands = release(context)

    assert.ok(commands.includes("git merge --ff-only origin/master"), "expected a fast-forward-only sync")
    assert.equal(commands.includes("git merge origin/master"), false, "a permissive merge must never be used")
    assert.ok(commands.indexOf("git checkout master") < commands.indexOf("git merge --ff-only origin/master"))
  })
})

test("validates the manifest after syncing master, before any release mutation", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const commands = release(context)
    const syncIndex = commands.indexOf("git merge --ff-only origin/master")
    const firstMutationIndex = commands.findIndex(isReleaseMutation)

    assert.ok(syncIndex >= 0 && firstMutationIndex >= 0, "expected a sync and a mutation")
    assert.ok(syncIndex < firstMutationIndex, "master must be synced before any release mutation")
  })
})

test("checks the registry for the exact next version before any release mutation", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const commands = release(context)
    const preflightIndex = commands.indexOf("npm view my-pkg@2.0.1 version")
    const firstMutationIndex = commands.findIndex(isReleaseMutation)

    assert.ok(preflightIndex >= 0 && firstMutationIndex >= 0, "expected a preflight and a mutation")
    assert.ok(preflightIndex < firstMutationIndex, "the duplicate preflight must run before any mutation")
  })
})

test("treats a stable E404 lookup as available and proceeds to publish", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    const commands = release(context)

    assert.ok(commands.includes("npm view my-pkg@2.0.1 version"), "expected the next-version preflight to run")
    assert.ok(commands.includes("npm version 2.0.1 --no-git-tag-version"), "an E404 must allow the version write")
    assert.ok(commands.includes("npm publish"), "an E404 must allow the release to publish")
  })
})

test("ignored build output does not trip the stray-change guard", () => {
  withRelease({scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v1.0.0"], gitignore: "node_modules\ngenerated.log\n"}, (context) => {
    // generated.log is ignored, so the release proceeds to tag, push and publish despite the build output.
    release(context, {env: {BUILD_IGNORED_FILE: "generated.log"}})
    assert.ok(registryOf(context).includes("fixture-package@1.0.1"))
  })
})

test("fails with an actionable bootstrap message when no valid release tag exists", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: []}, (context) => {
    const output = assertBlocked(context, /could not find a valid vX\.Y\.Z release tag/u)

    assert.match(output, /git tag -a v0\.0\.0 -m v0\.0\.0/u)
    assert.match(output, /--resume/u)
  })
})

test("fails with an actionable message when only malformed or non-semver tags exist", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["banana", "v1.2", "1.2.3", "vX.Y.Z", "v1.2.3-rc.1"]}, (context) => {
    assertBlocked(context, /could not find a valid vX\.Y\.Z release tag/u)
  })
})

test("rejects leading-zero version components instead of canonicalizing them", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0", "v01.9.9", "v1.00.0"]}, (context) => {
    const commands = release(context)

    assert.ok(commands.includes("npm version 1.0.1 --no-git-tag-version"))
    assert.equal(ranCommand(commands, "npm version 1.9."), false)
  })
})

test("fails when the only tags carry leading-zero components", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v01.2.3", "v1.02.3", "v1.2.03"]}, (context) => {
    assertBlocked(context, /could not find a valid vX\.Y\.Z release tag/u)
  })
})

test("fails clearly when the latest tag's version component exceeds the safe integer range", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.9007199254740993"]}, (context) => {
    assertBlocked(context, /safe integer/u)
  })
})

test("fails clearly when the latest patch is at the safe integer limit and cannot be incremented", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.9007199254740991"], published: ["fixture-package@1.0.9007199254740991"]}, (context) => {
    assertBlocked(context, /safe integer/u)
  })
})

test("fails with an actionable message when package.json declares no name", () => {
  withRelease({name: null, scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertBlocked(context, /package\.json is missing a valid "name"/u)
  })
})

test("fails with an actionable message when the package name is only whitespace", () => {
  withRelease({name: "   ", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertBlocked(context, /package\.json is missing a valid "name"/u)
  })
})

test("rejects a syntactically invalid npm package name using npm's own name grammar", () => {
  withRelease({name: "Invalid Name", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertBlocked(context, /is not a valid npm package name/u)
  })
})

test("accepts a valid scoped package name and publishes it", () => {
  withRelease({name: "@scope/pkg", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: ["@scope/pkg@1.0.0"]}, (context) => {
    release(context)
    assert.ok(registryOf(context).includes("@scope/pkg@1.0.1"))
  })
})

test("refuses to release a package marked private without pushing or publishing", () => {
  withRelease({name: "secret-pkg", private: true, scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    const output = assertBlocked(context, /marked "private": true and cannot be published/u)

    assert.match(output, /secret-pkg/u)
  })
})

test("refuses to release when the working tree has uncommitted changes", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    writeFileSync(join(context.work, "uncommitted.txt"), "dirty\n")
    assertBlocked(context, /working tree has uncommitted changes/u)
  })
})

test("rejects unknown CLI arguments before doing anything", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertBlocked(context, /unknown argument "--bogus"/u, {args: ["--bogus"]})
  })
})

/**
 * Adds an untagged published baseline commit followed by newer development on master.
 * @param {ScenarioContext} context The scenario context.
 * @param {{name?: string, baselineName?: string, baselineVersion?: string, currentVersion?: string, currentScripts?: Record<string, string>}} [options] Fixture values.
 * @returns {string} The untagged baseline commit SHA.
 */
function addUntaggedPublishedBaseline(context, options) {
  const fixture = Object.assign({name: "my-pkg", baselineName: "my-pkg", baselineVersion: "0.5.10", currentVersion: "0.6.0", currentScripts: {}}, options)
  const name = fixture.name
  const baselineVersion = fixture.baselineVersion

  writeFileSync(join(context.work, "package.json"), JSON.stringify({name: fixture.baselineName, version: baselineVersion, scripts: {}}, null, 2) + "\n")
  git(context.work, ["add", "package.json"])
  git(context.work, ["commit", "-m", `release ${baselineVersion} without tag`])
  const baselineHead = revParse(context.work, "HEAD")

  writeFileSync(join(context.work, "package.json"), JSON.stringify({name, version: fixture.currentVersion, scripts: fixture.currentScripts}, null, 2) + "\n")
  git(context.work, ["add", "package.json"])
  git(context.work, ["commit", "-m", "later development"])
  git(context.work, ["push", "origin", "master"])
  writeFileSync(context.registryFile, JSON.stringify([`${name}@0.5.9`, `${name}@${baselineVersion}`]))

  return baselineHead
}

/**
 * Runs the guarded reconciliation mode and asserts it fails without release mutations.
 * @param {ScenarioContext} context The scenario context.
 * @param {RegExp} pattern Expected diagnostic.
 * @param {string} gitHead Registry gitHead fixture.
 */
function assertReconciliationBlocked(context, pattern, gitHead) {
  assertBlocked(context, pattern, {
    args: ["--reconcile-published", "0.5.10", "--expected-git-head", gitHead],
    env: {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: gitHead}
  })
}

test("reconciles an exact untagged published baseline and releases the following patch", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    const commands = release(context, {
      args: ["--reconcile-published", "0.5.10", "--expected-git-head", baselineHead],
      env: {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: baselineHead}
    })

    assert.equal(git(context.origin, ["cat-file", "-t", "v0.5.10"]).trim(), "tag")
    assert.equal(revParse(context.origin, "v0.5.10^{commit}"), baselineHead)
    assert.ok(registryOf(context).includes("my-pkg@0.5.11"))
    assert.ok(commands.includes("npm view my-pkg@0.5.10 version gitHead --json"))
    assert.ok(commands.includes(`git tag -a v0.5.10 ${baselineHead} -m v0.5.10`))
    assert.ok(commands.includes("git push origin v0.5.10"))
    assert.ok(commands.indexOf("git push origin v0.5.10") < commands.indexOf("npm version 0.5.11 --no-git-tag-version"))
  })
})

test("reconciliation rejects registry gitHead that differs from the operator's expected baseline SHA", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    const differentExpectedHead = revParse(context.work, "HEAD")

    assertBlocked(context, /registry gitHead .* does not exactly match.*expected baseline/u, {
      args: ["--reconcile-published", "0.5.10", "--expected-git-head", differentExpectedHead],
      env: {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: baselineHead}
    })
  })
})

test("reconciliation rejects an unpublished preceding annotated tag", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    writeFileSync(context.registryFile, JSON.stringify(["my-pkg@0.5.10"]))
    assertReconciliationBlocked(context, /preceding release tag v0\.5\.9 is not published/u, baselineHead)
  })
})

test("reconciliation fails closed before tagging when registry provenance is incomplete", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    assertBlocked(context, /registry metadata.*gitHead/u, {
      args: ["--reconcile-published", "0.5.10", "--expected-git-head", baselineHead],
      env: {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: ""}
    })
  })
})

test("reconciliation rejects a gitHead outside origin master history", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    addUntaggedPublishedBaseline(context)
    git(context.work, ["checkout", "--orphan", "foreign"])
    git(context.work, ["commit", "--allow-empty", "-m", "foreign history"])
    const foreignHead = revParse(context.work, "HEAD")
    git(context.work, ["checkout", "master"])

    assertReconciliationBlocked(context, /not an ancestor of origin\/master/u, foreignHead)
  })
})

test("reconciliation rejects a registry gitHead that does not exist locally after fetch", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    addUntaggedPublishedBaseline(context)
    assertReconciliationBlocked(context, /gitHead f{40}.*missing from this repository/u, "f".repeat(40))
  })
})

test("reconciliation rejects package identity or version mismatches at registry gitHead", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const wrongPackageHead = addUntaggedPublishedBaseline(context, {baselineName: "other-pkg"})
    assertReconciliationBlocked(context, /package\.json at .* declares name other-pkg/u, wrongPackageHead)
  })
})

test("reconciliation rejects a version mismatch at registry gitHead", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const wrongVersionHead = addUntaggedPublishedBaseline(context, {baselineVersion: "0.5.8"})
    assertReconciliationBlocked(context, /declares version 0\.5\.8, not registry version 0\.5\.10/u, wrongVersionHead)
  })
})

test("reconciliation refuses an existing tag instead of moving or replacing it", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    git(context.work, ["tag", "-a", "v0.5.10", "v0.5.9^{commit}", "-m", "wrong target"])
    git(context.work, ["push", "origin", "v0.5.10"])

    assertReconciliationBlocked(context, /tag v0\.5\.10 already exists/u, baselineHead)
    assert.equal(revParse(context.origin, "v0.5.10^{commit}"), revParse(context.origin, "v0.5.9^{commit}"))
  })
})

test("reconciliation preserves duplicate protection before creating the baseline tag", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    writeFileSync(context.registryFile, JSON.stringify(["my-pkg@0.5.9", "my-pkg@0.5.10", "my-pkg@0.5.11"]))

    assertReconciliationBlocked(context, /my-pkg@0\.5\.11 is already published/u, baselineHead)
    assert.equal(git(context.work, ["tag", "-l", "v0.5.10"]).trim(), "")
  })
})

const reconciliationRetryFailures = /** @type {Array<[string, Record<string, string>]>} */ ([
  ["npm version", {NPM_VERSION_FAIL: "1"}],
  ["build", {BUILD_FAIL: "1"}],
  ["publish dry-run", {NPM_DRYRUN_FAIL: "1"}]
])

for (const [failureName, env] of reconciliationRetryFailures) {
  test(`reconciliation rolls back a failed ${failureName} so the exact invocation can be retried`, () => {
    withRelease({name: "my-pkg", version: "0.5.9", scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
      const baselineHead = addUntaggedPublishedBaseline(context, {currentScripts: {build: "tsc"}})
      const args = ["--reconcile-published", "0.5.10", "--expected-git-head", baselineHead]
      const metadataEnv = {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: baselineHead}
      const first = runCli(context, {args, env: {...metadataEnv, ...env}})

      assert.ok(first.failure, `the ${failureName} fixture must fail`)
      assert.equal(git(context.work, ["status", "--porcelain"]).trim(), "", "rollback must restore a clean tree")
      assert.equal(git(context.work, ["tag", "-l", "v0.5.11"]).trim(), "", "rollback must remove the local release tag")
      assert.equal(revParse(context.work, "HEAD"), revParse(context.origin, "master"), "rollback must restore synced master")

      clearCommands(context)
      release(context, {args, env: metadataEnv})
      assert.ok(registryOf(context).includes("my-pkg@0.5.11"), "the exact invocation must succeed on retry")
    })
  })
}

test("an ambiguous atomic push failure preserves exact state for package-owned resume recovery", () => {
  withRelease({name: "my-pkg", version: "0.5.9", scripts: {}, packageLock: true, annotatedTags: ["v0.5.9"]}, (context) => {
    const baselineHead = addUntaggedPublishedBaseline(context)
    const args = ["--reconcile-published", "0.5.10", "--expected-git-head", baselineHead]
    const metadataEnv = {NPM_METADATA_VERSION: "0.5.10", NPM_METADATA_GIT_HEAD: baselineHead}
    const first = runCli(context, {args, env: {...metadataEnv, GIT_ATOMIC_PUSH_FAIL: "1"}})

    assert.ok(first.failure, "the atomic push fixture must fail")
    assert.match(first.output, /atomic push.*--resume/u)
    assert.equal(git(context.work, ["status", "--porcelain"]).trim(), "", "the release state must stay clean")
    assert.equal(revParse(context.work, "v0.5.11^{commit}"), revParse(context.work, "HEAD"), "the exact release tag must remain")

    clearCommands(context)
    release(context, {resume: true})
    assert.ok(registryOf(context).includes("my-pkg@0.5.11"), "resume must finish the exact release")
  })
})

test("fails as a duplicate and mutates nothing when the exact next version is already published", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0", "my-pkg@2.0.1"]}, (context) => {
    assertBlocked(context, /my-pkg@2\.0\.1 is already published/u)
  })
})

test("blocks all release mutations when the registry lookup fails for an unrelated reason", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    assertBlocked(context, /could not determine whether my-pkg@2\.0\.1 is already published/u, {
      env: {NPM_VIEW_ERROR_VERSION: "2.0.1", NPM_VIEW_ERROR_STDERR: "npm error code ENOTFOUND\nnpm error network request to registry failed", NPM_VIEW_ERROR_EXIT: "1"}
    })
  })
})

test("blocks when the lookup mixes an E404 with another error code", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v2.0.0"], published: ["my-pkg@2.0.0"]}, (context) => {
    assertBlocked(context, /could not determine whether my-pkg@2\.0\.1 is already published/u, {
      env: {NPM_VIEW_ERROR_VERSION: "2.0.1", NPM_VIEW_ERROR_STDERR: "npm error code E404\nnpm error code E401 Unauthorized", NPM_VIEW_ERROR_EXIT: "1"}
    })
  })
})

test("blocks a normal release when the latest annotated tag is not published on npm", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    const output = assertBlocked(context, /latest release tag v1\.0\.0 is not published on npm/u)

    assert.match(output, /--resume/u)
  })
})

/**
 * Asserts a failed release recorded nothing: no commit, tag or push, an unmoved HEAD, no local
 * v1.0.1 tag left to poison the next derivation and no publish of the default fixture package.
 * @param {ScenarioContext} context The scenario context.
 * @param {string[]} commands The commands recorded during the run.
 * @param {string} headBefore The work-tree HEAD captured before the run.
 */
function assertFailedReleaseRecordedNothing(context, commands, headBefore) {
  assert.equal(ranCommand(commands, "git commit"), false, "no release commit may be recorded")
  assert.equal(ranCommand(commands, "git tag -a"), false, "no release tag may be created")
  assert.equal(ranCommand(commands, "git push"), false, "nothing may be pushed")
  assert.equal(git(context.work, ["tag", "-l", "v1.0.1"]).trim(), "", "no local v1.0.1 tag may be created")
  assert.equal(revParse(context.work, "HEAD"), headBefore, "HEAD must be unchanged")
  assert.equal(registryOf(context).includes("fixture-package@1.0.1"), false)
}

test("a failed publish dry-run leaves no release commit or tag behind", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    const headBefore = revParse(context.work, "HEAD")
    const {failure} = runCli(context, {env: {NPM_DRYRUN_FAIL: "1"}})

    assert.ok(failure, "a failed dry-run must fail the release")

    assertFailedReleaseRecordedNothing(context, commandsOf(context), headBefore)
  })
})

test("refuses to tag or push when the working tree still has stray changes after committing", () => {
  withRelease({scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    // The build emits a non-ignored file that is not part of the intended version commit.
    const {failure, output} = runCli(context, {env: {BUILD_STRAY_FILE: "generated.txt"}})

    assert.ok(failure, "a stray working-tree change must fail the release")
    assert.match(output, /stray files/u)

    const commands = commandsOf(context)

    assert.equal(ranCommand(commands, "git tag -a"), false, "no tag may be created with stray changes present")
    assert.equal(ranCommand(commands, "git push"), false, "nothing may be pushed with stray changes present")
    assert.equal(git(context.work, ["tag", "-l", "v1.0.1"]).trim(), "")
    assert.equal(registryOf(context).includes("fixture-package@1.0.1"), false)
  })
})

test("a failed real publish pushes the tag, explains recovery, and resume finishes it exactly", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: ["my-pkg@1.0.0"]}, (context) => {
    const {failure, output} = runCli(context, {env: {NPM_PUBLISH_FAIL: "1"}})

    assert.ok(failure, "a failed publish must surface a non-zero exit")
    assert.match(output, /tagged on origin but not on npm/u)
    assert.match(output, /--resume/u)

    // The commit and tag reached origin before publish failed, so recovery must not re-create them.
    assert.equal(git(context.origin, ["cat-file", "-t", "v1.0.1"]).trim(), "tag")
    assert.equal(registryOf(context).includes("my-pkg@1.0.1"), false)

    const headAfterFailure = revParse(context.work, "HEAD")
    const tagsAfterFailure = git(context.work, ["tag", "-l"]).trim()

    clearCommands(context)

    const resumeCommands = release(context, {resume: true})

    assert.ok(registryOf(context).includes("my-pkg@1.0.1"), "resume must publish the exact tagged version")
    assert.equal(ranCommand(resumeCommands, "npm version "), false, "resume must not bump")
    assert.equal(ranCommand(resumeCommands, "git commit"), false, "resume must not commit")
    assert.equal(ranCommand(resumeCommands, "git tag -a"), false, "resume must not create another tag")
    assert.equal(revParse(context.work, "HEAD"), headAfterFailure, "resume must not move HEAD")
    assert.equal(git(context.work, ["tag", "-l"]).trim(), tagsAfterFailure, "resume must not add tags")
  })
})

test("resume publishes the exact latest annotated tag when it matches HEAD and package.json", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    const headBefore = revParse(context.work, "HEAD")
    const commands = release(context, {resume: true})

    assert.ok(registryOf(context).includes("my-pkg@1.0.0"), "resume must publish the exact tagged version")
    assert.ok(commands.includes("npm publish") && commands.includes("npm publish --dry-run"))
    assert.equal(ranCommand(commands, "npm version "), false)
    assert.equal(ranCommand(commands, "git tag -a"), false)
    assert.equal(revParse(context.work, "HEAD"), headBefore)
  })
})

test("bootstrap: resume publishes an initial tag and pushes it to origin", () => {
  withRelease({name: "my-pkg", version: "0.0.0", scripts: {}, packageLock: true, annotatedTags: ["v0.0.0"], published: [], pushTags: false}, (context) => {
    // The bootstrap tag exists locally only and is unpublished.
    assert.equal(git(context.origin, ["tag", "-l"]).trim(), "")

    release(context, {resume: true})

    assert.ok(registryOf(context).includes("my-pkg@0.0.0"), "resume must publish the initial tagged version")
    assert.equal(git(context.origin, ["cat-file", "-t", "v0.0.0"]).trim(), "tag", "resume must push the tag to origin")
    assert.equal(revParse(context.origin, "v0.0.0^{commit}"), revParse(context.origin, "master"))
  })
})

test("resume is a verified no-op when the tagged version is already published", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: ["my-pkg@1.0.0"]}, (context) => {
    const commands = release(context, {resume: true})

    assert.deepEqual(registryOf(context), ["my-pkg@1.0.0"], "resume must not republish an already-published version")
    assert.equal(commands.includes("npm publish"), false, "an already-published version needs no publish")
    assert.ok(commands.includes("npm view my-pkg@1.0.0 version"), "resume must verify the published version")
  })
})

test("resume refuses when the latest tag does not point at the current master HEAD", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: [], extraCommit: true}, (context) => {
    const {failure, output} = runCli(context, {resume: true})

    assert.ok(failure, "resume must refuse a tag that is not on HEAD")
    assert.match(output, /can only publish v1\.0\.0 when it points at the current master HEAD/u)
    assert.equal(registryOf(context).includes("my-pkg@1.0.0"), false)
  })
})

test("resume refuses when package.json version does not match the tag", () => {
  withRelease({name: "my-pkg", version: "2.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    const {failure, output} = runCli(context, {resume: true})

    assert.ok(failure, "resume must refuse when package.json and the tag disagree")
    assert.match(output, /package\.json version \(2\.0\.0\) to exactly match the tag v1\.0\.0/u)
    assert.equal(registryOf(context).includes("my-pkg@1.0.0"), false)
  })
})

// --- Issue 1: resume must guarantee the pushed/published tree exactly matches the tagged commit. ---

/**
 * Asserts a resume run was blocked by the exact-tree integrity gate after install/build/dry-run,
 * pushing and publishing nothing.
 * @param {ScenarioContext} context The scenario context.
 * @param {{env: Record<string, string>, scripts?: Record<string, string>}} runOptions The run controls.
 */
function assertResumeTreeDrifted(context, runOptions) {
  const {failure, output} = runCli(context, {resume: true, env: runOptions.env})

  assert.ok(failure, "a tree that drifted from the tag must block resume")
  assert.match(output, /no longer matches the commit tagged v1\.0\.0/u)

  const commands = commandsOf(context)

  assert.equal(ranCommand(commands, "git push"), false, "nothing may be pushed once the tree drifted from the tag")
  assert.equal(commands.includes("npm publish"), false, "the real publish must not run once the tree drifted from the tag")
  assert.equal(registryOf(context).includes("my-pkg@1.0.0"), false, "nothing may be published once the tree drifted")
}

test("resume refuses to push or publish when install mutates a tracked file of the tagged tree", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    assertResumeTreeDrifted(context, {env: {INSTALL_TRACKED_FILE: ".gitignore"}})
  })
})

test("resume refuses to push or publish when the build emits a non-ignored file into the tagged tree", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    assertResumeTreeDrifted(context, {env: {BUILD_STRAY_FILE: "generated.txt"}})
  })
})

test("resume refuses to push or publish when the publish dry-run leaves a non-ignored file behind", () => {
  withRelease({name: "my-pkg", version: "1.0.0", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: []}, (context) => {
    assertResumeTreeDrifted(context, {env: {DRYRUN_STRAY_FILE: "generated.txt"}})
  })
})

// --- Issue 2: normal mode must never strand a pre-tag commit or commit anything but existing manifests. ---

/**
 * Asserts a stray non-ignored change from the given release step blocks before the commit, leaving
 * HEAD, the tags and the registry untouched.
 * @param {ScenarioContext} context The scenario context.
 * @param {Record<string, string>} env The env that steers the release step to emit a stray file.
 */
function assertStrayChangeBlocksBeforeCommit(context, env) {
  const headBefore = revParse(context.work, "HEAD")
  const {failure, output} = runCli(context, {env})

  assert.ok(failure, "a stray change must fail the release")
  assert.match(output, /stray files/u)

  assertFailedReleaseRecordedNothing(context, commandsOf(context), headBefore)
}

test("a stray build change blocks before committing and leaves HEAD and tags untouched", () => {
  withRelease({scripts: {build: "tsc"}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertStrayChangeBlocksBeforeCommit(context, {BUILD_STRAY_FILE: "generated.txt"})
  })
})

test("a stray dry-run change blocks before committing and leaves HEAD and tags untouched", () => {
  withRelease({scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
    assertStrayChangeBlocksBeforeCommit(context, {DRYRUN_STRAY_FILE: "generated.txt"})
  })
})

test("a newly generated lockfile is rejected and never committed into the release", () => {
  withRelease({scripts: {}, annotatedTags: ["v1.0.0"]}, (context) => {
    const headBefore = revParse(context.work, "HEAD")
    const {failure, output} = runCli(context, {env: {INSTALL_LOCKFILE: "1"}})

    assert.ok(failure, "a newly generated lockfile must fail the release")
    assert.match(output, /package-lock\.json/u)

    const commands = commandsOf(context)

    assert.equal(ranCommand(commands, "git add package-lock.json"), false, "a newly generated lockfile must never be staged")
    assertFailedReleaseRecordedNothing(context, commands, headBefore)
  })
})

test("a tag-creation failure rolls the release commit back and a retry then releases the intended version", () => {
  withRelease({name: "my-pkg", scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"], published: ["my-pkg@1.0.0"]}, (context) => {
    const headBefore = revParse(context.work, "HEAD")

    // Force annotated tag creation to fail deterministically: require tag signing but point gpg at a
    // program that always fails, so `git tag -a` errors while the unsigned commit still succeeds.
    git(context.work, ["config", "tag.gpgsign", "true"])
    git(context.work, ["config", "gpg.program", "/bin/false"])

    const {failure, output} = runCli(context)

    assert.ok(failure, "a failed tag creation must fail the release")
    assert.match(output, /rolled back/u)
    assert.match(output, new RegExp(headBefore.slice(0, 12)), "the recovery message must report the restored HEAD")

    const commands = commandsOf(context)

    assert.ok(ranCommand(commands, "git commit"), "the release commit is created before the tag can fail")
    assert.ok(ranCommand(commands, `git reset --hard ${headBefore}`), "the stranded release commit must be rolled back")
    assert.equal(ranCommand(commands, "git push"), false, "nothing may be pushed after a tag failure")
    assert.equal(revParse(context.work, "HEAD"), headBefore, "HEAD must be restored to the pre-release commit")
    assert.equal(git(context.work, ["tag", "-l", "v1.0.1"]).trim(), "", "no new tag may remain after the rollback")
    assert.equal(git(context.work, ["status", "--porcelain"]).trim(), "", "the tree must be clean after the rollback")
    assert.equal(registryOf(context).includes("my-pkg@1.0.1"), false)

    // Restore signing config and retry: the intended version now releases end to end.
    git(context.work, ["config", "tag.gpgsign", "false"])
    git(context.work, ["config", "--unset", "gpg.program"])
    clearCommands(context)

    release(context)

    assert.ok(registryOf(context).includes("my-pkg@1.0.1"), "the retry must publish the intended version")
    assert.equal(git(context.origin, ["cat-file", "-t", "v1.0.1"]).trim(), "tag", "the retry must push the annotated tag")
    assert.equal(revParse(context.origin, "v1.0.1^{commit}"), revParse(context.origin, "master"))
  })
})

test("does not let a malicious package name reach the shell or the registry", () => {
  const markerDirectory = mkdtempSync(join(tmpdir(), "release-patch-marker-"))
  const marker = join(markerDirectory, "pwned")

  try {
    withRelease({name: `evil-$(touch ${marker})`, scripts: {}, packageLock: true, annotatedTags: ["v1.0.0"]}, (context) => {
      // npm's name grammar rejects the hostile name outright, before any command could execute it.
      assertBlocked(context, /is not a valid npm package name/u)
      assert.equal(existsSync(marker), false, "a malicious package name must never execute injected shell commands")
    })
  } finally {
    rmSync(markerDirectory, {force: true, recursive: true})
  }
})
