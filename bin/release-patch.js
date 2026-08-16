#!/usr/bin/env node
import {execFileSync, execSync} from "node:child_process"
import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"
import validateNpmPackageName from "validate-npm-package-name"

// `preversion` runs before the version bump, and publish hooks run after the push.
const releaseLifecycleScriptNames = ["version", "postversion"]

// The intended release commit carries exactly these version manifests and nothing else; they are
// staged by name so a stray secret or build artifact can never be swept into the release with them.
const versionManifestFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json"]

// npm's read path can lag a successful publish. This bounded schedule checks for up to 150 seconds:
// quickly at first, then at 30-second intervals so ordinary propagation does not look like failure.
const registryVisibilityWaitSeconds = [1, 2, 4, 8, 15, 30, 30, 30, 30]
const registryVisibilityAttempts = registryVisibilityWaitSeconds.length + 1
const registryVisibilityWindowSeconds = registryVisibilityWaitSeconds.reduce((total, seconds) => total + seconds, 0)

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
 * Runs a command with explicit arguments and captures stdout.
 * @param {string} file The executable to run.
 * @param {string[]} args The arguments passed verbatim to the executable.
 * @returns {string} The command's stdout.
 */
function runCaptureArgs(file, args) {
  return execFileSync(file, args, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]})
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
 * Parses the CLI invocation, accepting only the documented flags and rejecting anything else so a
 * typo can never be silently ignored and run a destructive default.
 * @param {string[]} argv The full `process.argv`.
 * @returns {{resume: boolean, reconcilePublished?: string, expectedGitHead?: string}} The parsed release mode.
 */
function parseCliArgs(argv) {
  const args = argv.slice(2)

  if (args.length === 0) return {resume: false}
  if (args[0] === "--resume") return parseResumeArgs(args)
  if (args[0] === "--reconcile-published") {
    return parseReconcileArgs(args)
  }

  throw new Error(
    `release-patch: unknown argument ${JSON.stringify(args[0])}. Supported modes are --resume and ` +
    "--reconcile-published X.Y.Z --expected-git-head <SHA>; run without flags for a normal patch release."
  )
}

/**
 * @param {string[]} args CLI arguments beginning with --resume.
 * @returns {{resume: boolean}} Resume mode.
 */
function parseResumeArgs(args) {
  if (args.length === 1) return {resume: true}
  throw new Error("release-patch: --resume cannot be combined with another release mode or argument.")
}

/**
 * @param {string[]} args CLI arguments beginning with --reconcile-published.
 * @returns {{resume: boolean, reconcilePublished: string, expectedGitHead: string}} Reconcile mode.
 */
function parseReconcileArgs(args) {
  if (args.length !== 4) throwInvalidReconcileArgs()
  if (parseReleaseTag(`v${args[1]}`) === null) throwInvalidReconcileArgs()

  return {resume: false, reconcilePublished: args[1], expectedGitHead: parseExpectedGitHead(args[2], args[3])}
}

/**
 * @param {string} flag Expected flag.
 * @param {string} sha Expected SHA.
 * @returns {string} Validated SHA.
 */
function parseExpectedGitHead(flag, sha) {
  if (flag !== "--expected-git-head") throwInvalidReconcileArgs()
  if (!/^[0-9a-f]{40}$/u.test(sha)) throwInvalidReconcileArgs()
  return sha
}

/**
 * @returns {never} Always throws.
 */
function throwInvalidReconcileArgs() {
  throw new Error(
    "release-patch: reconciliation requires `--reconcile-published X.Y.Z --expected-git-head <40-character lowercase SHA>`."
  )
}

/**
 * Reads the consuming package's `package.json` from the current working directory.
 * @returns {{name?: string, version?: string, private?: boolean, scripts?: Record<string, string>}} The parsed package manifest.
 */
function readPackageJson() {
  const packageJsonPath = resolve(process.cwd(), "package.json")

  return JSON.parse(readFileSync(packageJsonPath, "utf8"))
}

/**
 * Reads and validates the consuming manifest, ensuring it can actually be published before the
 * release makes any side effects.
 * @returns {{name: string, version?: string, private?: boolean, scripts?: Record<string, string>}} The validated manifest.
 */
function readValidatedPackageJson() {
  const packageJson = readPackageJson()

  if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
    throw new Error(
      'release-patch: package.json is missing a valid "name"; a published package must declare a non-empty name.'
    )
  }

  ensureValidPackageName(packageJson.name)

  if (packageJson.private === true) {
    throw new Error(
      `release-patch: package ${packageJson.name} is marked "private": true and cannot be published to npm; ` +
      "remove the private flag or use a different release process."
    )
  }

  return /** @type {{name: string, version?: string, private?: boolean, scripts?: Record<string, string>}} */ (packageJson)
}

/**
 * Rejects a name npm itself would refuse to publish. Reusing npm's maintained grammar lets valid
 * scoped names through while catching bad characters, capitals, length and reserved names.
 * @param {string} name The package name from the manifest.
 */
function ensureValidPackageName(name) {
  const nameCheck = validateNpmPackageName(name)

  if (nameCheck.validForNewPackages) return

  throw new Error(
    `release-patch: package.json "name" ${JSON.stringify(name)} is not a valid npm package name: ` +
    `${packageNameProblems(nameCheck)}.`
  )
}

/**
 * Summarizes why npm rejected a package name.
 * @param {{errors?: string[], warnings?: string[]}} nameCheck The validation result.
 * @returns {string} The joined problems, or a generic fallback.
 */
function packageNameProblems(nameCheck) {
  const problems = [...(nameCheck.errors ?? []), ...(nameCheck.warnings ?? [])]

  return problems.length > 0 ? problems.join("; ") : "npm would reject it on publish"
}

/** Fails the release when the working tree is dirty so stray changes cannot leak into the release commit. */
function ensureCleanWorkingTree() {
  const status = runCapture("git status --porcelain")

  if (status.trim() !== "") {
    throw new Error(
      "release-patch: the working tree has uncommitted changes; commit, stash or discard them before releasing " +
      "so the release commit contains only the version bump."
    )
  }
}

/** Logs in to npm if there is no authenticated user yet. */
function ensureNpmAuth() {
  try {
    execSync("npm whoami", {stdio: "ignore"})
  } catch {
    run("npm login")
  }
}

/**
 * Ensures the release runs from the latest local `master` synced with `origin/master`.
 * The merge is fast-forward-only: if local master has diverged from origin, the sync fails loudly
 * instead of inventing a merge commit that would then be tagged and published as a release.
 */
function ensureLatestMaster() {
  run("git checkout master")
  run("git fetch origin")
  run("git merge --ff-only origin/master")
}

/**
 * Fetches tags from origin without disturbing local-only tags. A resume may publish a bootstrap tag
 * that has been created locally but not yet pushed, so it must not prune tags that origin lacks.
 */
function fetchTags() {
  run("git fetch origin --tags")
}

/**
 * Syncs tags so origin's tag set is authoritative before a normal release derives the next version.
 * `--prune --prune-tags` deletes local tags that no longer exist on origin (stale or never-pushed
 * local-only tags), and `--force` overwrites a local tag that origin has moved, so derivation can
 * never be driven or blocked by a tag origin does not currently have. Annotated-vs-lightweight
 * semantics are unaffected: force-updated tags keep their original object type.
 */
function fetchOriginAuthoritativeTags() {
  run("git fetch origin --tags --prune --prune-tags --force")
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
 * Renders a parsed version back into its `X.Y.Z` string form.
 * @param {{major: number, minor: number, patch: number}} version The parsed version.
 * @returns {string} The version in `X.Y.Z` form.
 */
function versionString(version) {
  return `${version.major}.${version.minor}.${version.patch}`
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
 * Enumerates every tag ref with its object type and keeps only exact stable annotated `vX.Y.Z`
 * release tags. `git for-each-ref` exposes `%(objecttype)`, which is `tag` for an annotated tag
 * object and `commit` for a lightweight tag; only annotated tags are authoritative, so lightweight,
 * malformed, pre-release and build tags are all ignored here.
 * @returns {Array<{tag: string, version: {major: number, minor: number, patch: number}}>} The annotated release tags.
 */
function annotatedReleaseTags() {
  // `%(objecttype)` distinguishes annotated (`tag`) from lightweight (`commit`) tags; the pipe
  // separator is safe because a ref short-name can never contain one.
  const output = runCapture('git for-each-ref --format="%(objecttype)|%(refname:short)" refs/tags')

  /** @type {Array<{tag: string, version: {major: number, minor: number, patch: number}}>} */
  const tags = []

  for (const rawLine of output.split("\n")) {
    const entry = parseTagRefLine(rawLine)

    if (entry !== null) tags.push(entry)
  }

  return tags
}

/**
 * Parses one `git for-each-ref` line into an annotated release tag, or null for lightweight,
 * malformed, pre-release and build tags.
 * @param {string} rawLine A single `%(objecttype)|%(refname:short)` line.
 * @returns {{tag: string, version: {major: number, minor: number, patch: number}} | null} The annotated release tag or null.
 */
function parseTagRefLine(rawLine) {
  const line = rawLine.trim()

  if (line === "") return null

  const separator = line.indexOf("|")

  // Only annotated tag objects are authoritative; a lightweight tag reports `commit` and is ignored.
  if (line.slice(0, separator) !== "tag") return null

  const tag = line.slice(separator + 1)
  const version = parseReleaseTag(tag)

  return version === null ? null : {tag, version}
}

/**
 * Finds the highest exact annotated `vX.Y.Z` release tag, ignoring lightweight and malformed tags.
 * @returns {{tag: string, version: {major: number, minor: number, patch: number}} | null} The latest annotated release tag or null.
 */
function latestAnnotatedReleaseTag() {
  const tags = annotatedReleaseTags()

  if (tags.length === 0) return null

  return tags.reduce((highest, candidate) => (compareVersions(candidate.version, highest.version) > 0 ? candidate : highest))
}

/**
 * Derives the next patch version from a parsed latest release version.
 * @param {{major: number, minor: number, patch: number}} latest The latest released version.
 * @returns {string} The next patch version in `X.Y.Z` form.
 */
function deriveNextPatchVersion(latest) {
  const nextPatch = latest.patch + 1

  if (!Number.isSafeInteger(nextPatch)) {
    throw new Error(
      `release-patch: the latest release tag v${versionString(latest)} has a patch ` +
      "component at the safe integer limit and cannot be incremented; bump the minor or major version manually."
    )
  }

  return `${latest.major}.${latest.minor}.${nextPatch}`
}

/**
 * Establishes whether the exact `<package>@<version>` is already published before any release
 * mutation runs. The package name comes from untrusted manifest metadata, so the registry is queried
 * with explicit arguments (never a shell). Only npm's stable E404/not-found result is treated as
 * "available"; a network, auth or any other lookup failure leaves the duplicate status unknown, so
 * the release is blocked rather than risking an overwrite or a race.
 * @param {string} packageName The package name from the validated, synced manifest.
 * @param {string} version The exact version about to be released.
 */
function ensureVersionAvailable(packageName, version) {
  const spec = `${packageName}@${version}`

  // A non-empty version response means the exact release already exists on the registry.
  if (lookupPublishedVersion(spec).trim() !== "") {
    throw new Error(
      `release-patch: ${spec} is already published to npm; refusing to overwrite an existing release. ` +
      "The Git tag source of truth is behind the registry — investigate the duplicate before releasing."
    )
  }
}

/**
 * Looks up an exact `<package>@<version>` on the registry, returning its version string (empty when
 * unpublished). Only an unambiguous npm E404 means available; any other lookup failure is fatal.
 * @param {string} spec The exact `<package>@<version>` spec to query.
 * @returns {string} The published version, or an empty string when the exact version is not published.
 */
function lookupPublishedVersion(spec) {
  try {
    return execFileSync("npm", ["view", spec, "version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]})
  } catch (error) {
    const output = registryLookupOutput(error)

    // A clean E404 (and nothing else) is the only failure that safely means the version is available.
    if (isRegistryNotFound(output)) return ""

    throw new Error(
      `release-patch: could not determine whether ${spec} is already published; the registry lookup failed for a ` +
      "reason other than a missing package (network, auth or registry error), so the release is unsafe. " +
      `Resolve the lookup failure and retry.\n${output.trim()}`
    )
  }
}

/**
 * Combines a failed lookup's captured stdout and stderr for classification and diagnostics.
 * @param {unknown} error The error thrown by the registry lookup.
 * @returns {string} The combined captured output.
 */
function registryLookupOutput(error) {
  const failure = /** @type {{stdout?: string, stderr?: string}} */ (error)

  return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
}

/**
 * Reports whether a failed registry lookup is unambiguously npm's "package/version not found"
 * result. npm prints one or more `code <CODE>` lines; the version is only safely available when the
 * single reported code is E404. A mixed failure (E404 alongside a network, auth or other code, or a
 * bare "404" with no code) is ambiguous and must block rather than risk an overwrite or a race.
 * @param {string} output The combined lookup output.
 * @returns {boolean} Whether the failure means the version is available to publish.
 */
function isRegistryNotFound(output) {
  const codes = new Set([...output.matchAll(/\bcode\s+(E[A-Z0-9]+)\b/gu)].map((match) => match[1].toUpperCase()))

  return codes.size === 1 && codes.has("E404")
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

/**
 * Runs the pre-push build gate when the package defines a build that no release lifecycle script runs.
 * @param {{scripts?: Record<string, string>}} packageJson The consuming package manifest.
 */
function runExplicitBuildIfNeeded(packageJson) {
  if (shouldRunExplicitBuild(packageJson)) {
    run("npm run build")
  }
}

/**
 * Lists the version manifests that already exist in the working directory. Captured on synced master
 * before install or the version bump can generate new ones, so a freshly created lockfile or
 * manifest can never be swept into the release commit as if it had always belonged there.
 * @returns {string[]} The subset of {@link versionManifestFiles} present right now.
 */
function existingVersionManifestFiles() {
  return versionManifestFiles.filter((file) => existsSync(resolve(process.cwd(), file)))
}

/**
 * Extracts the changed paths from `git status --porcelain` output, taking the destination side of a
 * rename so a moved file is judged by where it landed.
 * @param {string} status The porcelain status output.
 * @returns {string[]} The changed (tracked or non-ignored untracked) paths.
 */
function changedPaths(status) {
  /** @type {string[]} */
  const paths = []

  for (const line of status.split("\n")) {
    if (line.trim() === "") continue

    // Porcelain v1 lines are `XY <path>`; a rename is `XY <old> -> <new>`, and we track the new path.
    const entry = line.slice(3)
    const rename = entry.indexOf(" -> ")

    paths.push(rename >= 0 ? entry.slice(rename + 4) : entry)
  }

  return paths
}

/**
 * Before committing, refuses to continue if the version bump, build or publish dry-run changed
 * anything beyond the version manifests that already existed on synced master. This blocks stray build
 * output, generated files, secrets and — crucially — a newly generated lockfile from ever entering the
 * release commit, tag, push or publish.
 * @param {string[]} existingVersionManifests The version manifests captured on synced master.
 */
function ensureOnlyVersionManifestsChanged(existingVersionManifests) {
  // `git status --porcelain` reports tracked modifications and non-ignored untracked files but omits
  // ignored files, so ordinary ignored build output does not trip this gate while stray files do.
  const status = runCapture("git status --porcelain")
  const stray = changedPaths(status).filter((path) => !existingVersionManifests.includes(path))

  if (stray.length > 0) {
    throw new Error(
      "release-patch: refusing to create the release commit. After the version bump, build and publish dry-run, " +
      `changes appeared outside the version manifests that existed on master (${existingVersionManifests.join(", ")}). ` +
      "Refusing to sweep stray files (build output, generated files, a newly generated lockfile or secrets) into the " +
      `release commit, tag or push. Inspect \`git status\`, then ignore or clean them before releasing:\n${stray.join("\n")}`
    )
  }
}

/**
 * Commits exactly the version manifests that existed on synced master and were bumped. Each file is
 * staged by name — never `git add -A` — so nothing else can slip in, and a manifest generated after
 * the capture (for example a fresh lockfile) is never staged.
 * @param {string[]} existingVersionManifests The version manifests captured on synced master.
 */
function commitVersionFiles(existingVersionManifests) {
  for (const file of existingVersionManifests) {
    run(`git add ${file}`)
  }

  run('git commit -m "chore: bump patch version"')
}

/**
 * After the intended version commit, refuses to tag or push if any tracked or untracked non-ignored
 * change remains in the working tree. A publish dry-run or build lifecycle script can emit generated
 * files or secrets; tagging and pushing with them present would ship an inconsistent release, so this
 * blocks with an actionable error rather than blindly sweeping them into the release.
 */
function ensureNoStrayReleaseChanges() {
  // `git status --porcelain` lists tracked modifications and untracked files but omits ignored files,
  // so ordinary ignored build output does not trip this gate while stray non-ignored files do.
  const status = runCapture("git status --porcelain")

  if (status.trim() !== "") {
    throw new Error(
      "release-patch: the working tree still has changes after committing the version manifests. Refusing to " +
      "tag and push a release with stray files (build output, generated files or secrets) outside the intended " +
      `commit. Inspect \`git status\`, then ignore or clean them before releasing.\n${status.trim()}`
    )
  }
}

/**
 * Pushes the exact release commit and its annotated tag to origin atomically, then publishes and
 * verifies. The push never forces and is a no-op when origin already has both refs. If the real
 * publish fails after the push, the commit and tag are already public, so the error explains how to
 * finish with `release-patch --resume` and the non-zero exit is preserved.
 * @param {string} packageName The validated package name.
 * @param {string} version The exact version being released.
 * @param {string} releaseTag The annotated release tag (`v<version>`).
 */
function pushPublishAndVerify(packageName, version, releaseTag) {
  // Push the release commit and its exact tag together atomically, never forcing, so master is
  // never published without the matching release tag if the tag push would fail on its own.
  run(`git push --atomic origin master ${releaseTag}`)

  publishAndVerify(packageName, version, releaseTag)
}

/**
 * Publishes after the release refs are public, preserving resume recovery on any registry failure.
 * @param {string} packageName The validated package name.
 * @param {string} version The exact version being released.
 * @param {string} releaseTag The already-pushed annotated release tag.
 */
function publishAndVerify(packageName, version, releaseTag) {
  try {
    run("npm publish")
  } catch (error) {
    throw new Error(
      `release-patch: the release commit and tag ${releaseTag} were pushed to origin, but \`npm publish\` failed, ` +
      `so ${packageName}@${version} is tagged on origin but not on npm. After resolving the publish failure, run ` +
      "`release-patch --resume` to publish exactly this tagged version; it will not create another commit or tag.",
      {cause: error}
    )
  }

  verifyPublished(packageName, version)
}

/**
 * Verifies the exact version is live on the registry. The package name comes from package.json, so it
 * is passed as an argument (never through a shell) to avoid command injection.
 * @param {string} packageName The validated package name.
 * @param {string} version The exact version that should now be published.
 */
function verifyPublished(packageName, version) {
  const spec = `${packageName}@${version}`

  for (let attempt = 1; attempt <= registryVisibilityAttempts; attempt++) {
    if (lookupPublishedVersion(spec).trim() !== "") return
    waitForRegistryVisibility(spec, attempt, registryVisibilityWaitSeconds[attempt - 1])
  }

  throw new Error(
    `release-patch: ${spec} was published but did not become visible on npm after ` +
      `${registryVisibilityAttempts} attempts over ${registryVisibilityWindowSeconds} seconds. The release commit ` +
      "and tag are already on origin; once registry availability is restored, run `release-patch --resume` to " +
      "verify or finish this exact version without creating another release."
  )
}

/**
 * @param {string} spec The published package spec.
 * @param {number} attempt The one-based visibility attempt that just completed.
 * @param {number | undefined} waitSeconds Seconds before the next attempt; absent after the final attempt.
 */
function waitForRegistryVisibility(spec, attempt, waitSeconds) {
  if (waitSeconds === undefined) return

  console.log(
    `release-patch: published ${spec}; waiting for npm registry visibility ` +
      `(attempt ${attempt}/${registryVisibilityAttempts}); retrying in ${waitSeconds} seconds.`
  )
  run(`sleep ${waitSeconds}`)
}

/**
 * Reads the registry's immutable provenance fields for an exact published package version.
 * @param {string} packageName The validated package name.
 * @param {string} version The explicitly requested published baseline.
 * @returns {{version: string, gitHead: string}} Authenticated registry metadata.
 */
function publishedProvenance(packageName, version) {
  const spec = `${packageName}@${version}`
  let metadata

  try {
    metadata = JSON.parse(runCaptureArgs("npm", ["view", spec, "version", "gitHead", "--json"]))
  } catch (error) {
    throw new Error(
      `release-patch: could not authenticate registry metadata for ${spec}; refusing to reconcile an uncertain baseline.`,
      {cause: error}
    )
  }

  ensureExactPublishedProvenance(metadata, version, spec)

  return /** @type {{version: string, gitHead: string}} */ (metadata)
}

/**
 * @param {unknown} metadata Parsed npm metadata.
 * @param {string} version The exact requested version.
 * @param {string} spec Exact package spec for diagnostics.
 */
function ensureExactPublishedProvenance(metadata, version, spec) {
  const candidate = /** @type {{version?: unknown, gitHead?: unknown}} */ (Object(metadata))
  if (candidate.version !== version) throwInvalidPublishedProvenance(spec, version)
  if (typeof candidate.gitHead !== "string") throwInvalidPublishedProvenance(spec, version)
  if (!/^[0-9a-f]{40}$/u.test(candidate.gitHead)) throwInvalidPublishedProvenance(spec, version)
}

/**
 * @param {string} spec Package spec.
 * @param {string} version Expected version.
 * @returns {never} Always throws.
 */
function throwInvalidPublishedProvenance(spec, version) {
  throw new Error(
    `release-patch: registry metadata for ${spec} must unambiguously contain version ${version} and one full ` +
    "40-character lowercase hexadecimal gitHead; refusing to guess or tag."
  )
}

/**
 * Reports whether a Git command exits successfully without exposing expected failure output.
 * @param {string[]} args Git arguments.
 * @returns {boolean} Whether Git exited successfully.
 */
function gitSucceeds(args) {
  try {
    execFileSync("git", args, {stdio: "ignore"})
    return true
  } catch {
    return false
  }
}

/**
 * Proves the registry commit exists on authoritative master history and carries the exact package.
 * @param {string} gitHead The registry commit SHA.
 * @param {string} packageName The expected package identity.
 * @param {string} version The expected package version.
 */
function ensureRegistryCommitIdentity(gitHead, packageName, version) {
  ensureRegistryCommitExists(gitHead, packageName, version)
  ensureRegistryCommitReachable(gitHead, packageName, version)
  ensureHistoricalManifestIdentity(packageJsonAtCommit(gitHead), gitHead, packageName, version)
}

/**
 * @param {string} gitHead Commit SHA.
 * @param {string} packageName Package name.
 * @param {string} version Version.
 */
function ensureRegistryCommitExists(gitHead, packageName, version) {
  if (!gitSucceeds(["cat-file", "-e", `${gitHead}^{commit}`])) {
    throw new Error(`release-patch: registry gitHead ${gitHead} for ${packageName}@${version} is missing from this repository after fetching origin.`)
  }
}

/**
 * @param {string} gitHead Commit SHA.
 * @param {string} packageName Package name.
 * @param {string} version Version.
 */
function ensureRegistryCommitReachable(gitHead, packageName, version) {
  if (!gitSucceeds(["merge-base", "--is-ancestor", gitHead, "origin/master"])) {
    throw new Error(
      `release-patch: registry gitHead ${gitHead} for ${packageName}@${version} is not an ancestor of origin/master; ` +
      "it does not belong to the authoritative release history, so no tag was created."
    )
  }
}

/**
 * @param {{name?: string, version?: string}} historicalManifest Historical manifest.
 * @param {string} gitHead Commit SHA.
 * @param {string} packageName Expected package name.
 * @param {string} version Expected version.
 */
function ensureHistoricalManifestIdentity(historicalManifest, gitHead, packageName, version) {
  ensureHistoricalName(historicalManifest, gitHead, packageName)
  ensureHistoricalVersion(historicalManifest, gitHead, version)
}

/**
 * @param {{name?: string}} manifest Manifest.
 * @param {string} gitHead SHA.
 * @param {string} packageName Name.
 */
function ensureHistoricalName(manifest, gitHead, packageName) {
  if (manifest.name !== packageName) {
    throw new Error(
      `release-patch: package.json at registry gitHead ${gitHead} declares name ${manifest.name ?? "unset"}, ` +
      `not the current package identity ${packageName}; no tag was created.`
    )
  }
}

/**
 * @param {{version?: string}} manifest Manifest.
 * @param {string} gitHead SHA.
 * @param {string} version Version.
 */
function ensureHistoricalVersion(manifest, gitHead, version) {
  if (manifest.version !== version) {
    throw new Error(
      `release-patch: package.json at registry gitHead ${gitHead} declares version ${manifest.version ?? "unset"}, ` +
      `not registry version ${version}; no tag was created.`
    )
  }
}

/**
 * @param {string} gitHead The exact commit to inspect.
 * @returns {{name?: string, version?: string}} Its parsed package manifest.
 */
function packageJsonAtCommit(gitHead) {
  try {
    return JSON.parse(runCaptureArgs("git", ["show", `${gitHead}:package.json`]))
  } catch (error) {
    throw new Error(`release-patch: could not read an unambiguous package.json at registry gitHead ${gitHead}; no tag was created.`, {cause: error})
  }
}

/**
 * Creates an absent baseline tag or verifies an exact prior-attempt tag without ever replacing it.
 * @param {string} releaseTag The baseline tag.
 * @param {string} gitHead The authenticated target commit.
 */
function createOrVerifyBaselineTag(releaseTag, gitHead) {
  if (!gitSucceeds(["show-ref", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
    runArgs("git", ["tag", "-a", releaseTag, gitHead, "-m", releaseTag])
    return
  }

  const type = runCaptureArgs("git", ["cat-file", "-t", releaseTag]).trim()
  const target = runCaptureArgs("git", ["rev-parse", `${releaseTag}^{commit}`]).trim()
  if (type !== "tag" || target !== gitHead) {
    throw new Error(
      `release-patch: tag ${releaseTag} already exists but is not the expected annotated tag on registry gitHead ` +
      `${gitHead}; refusing to move, replace or force-push it.`
    )
  }
}

/**
 * Reconciles one explicitly named npm-published baseline that is missing its release tag, then uses
 * the unchanged normal release path to cut the following patch from that authenticated baseline.
 * @param {{name: string, version?: string, scripts?: Record<string, string>}} packageJson The current validated manifest.
 * @param {string} packageName The current validated package name.
 * @param {string} version The exact already-published baseline version.
 * @param {string} expectedGitHead The operator-reviewed baseline commit SHA.
 * @param {{tag: string, version: {major: number, minor: number, patch: number}} | null} latest The latest release tag.
 */
function runReconciledRelease(packageJson, packageName, version, expectedGitHead, latest) {
  const requestedVersion = /** @type {{major: number, minor: number, patch: number}} */ (parseReleaseTag(`v${version}`))
  ensureReconciliationFollowsLatest(latest, requestedVersion, version)
  ensurePrecedingTagPublished(packageName, requestedVersion)

  const {gitHead} = publishedProvenance(packageName, version)
  ensureExpectedGitHead(gitHead, expectedGitHead, packageName, version)
  ensureRegistryCommitIdentity(gitHead, packageName, version)

  // Prove the following patch is available before recording even the baseline tag. The unchanged
  // normal release repeats this duplicate preflight immediately before its own mutations.
  ensureVersionAvailable(packageName, deriveNextPatchVersion(requestedVersion))

  const releaseTag = `v${version}`
  createOrVerifyBaselineTag(releaseTag, gitHead)

  // Publish the authenticated immutable baseline tag by itself. If this non-force push fails, the
  // local exact tag remains for inspection and an idempotent retry; no version commit exists yet.
  runArgs("git", ["push", "origin", releaseTag])
  runNormalRelease(packageJson, packageName, {tag: releaseTag, version: /** @type {{major: number, minor: number, patch: number}} */ (parseReleaseTag(releaseTag))})
}

/**
 * Preserves the normal release invariant that the preceding authoritative tag is already on npm.
 * @param {string} packageName Package name.
 * @param {{major: number, minor: number, patch: number}} requestedVersion Reconciliation version.
 */
function ensurePrecedingTagPublished(packageName, requestedVersion) {
  const precedingVersion = `${requestedVersion.major}.${requestedVersion.minor}.${requestedVersion.patch - 1}`
  const precedingTag = `v${precedingVersion}`
  const annotatedPredecessorExists = annotatedReleaseTags().some(({tag}) => tag === precedingTag)

  if (!annotatedPredecessorExists) throwInvalidReconciliationSequence(versionString(requestedVersion), precedingTag)
  if (lookupPublishedVersion(`${packageName}@${precedingVersion}`).trim() !== "") return
  throw new Error(
    `release-patch: the preceding release tag ${precedingTag} is not published on npm; refusing to reconcile a later ` +
    "baseline that would bypass normal release history."
  )
}

/**
 * Makes the operator-reviewed SHA, not publisher-supplied npm metadata, the provenance trust anchor.
 * @param {string} registryGitHead Registry metadata SHA.
 * @param {string} expectedGitHead Operator-supplied SHA.
 * @param {string} packageName Package name.
 * @param {string} version Package version.
 */
function ensureExpectedGitHead(registryGitHead, expectedGitHead, packageName, version) {
  if (registryGitHead === expectedGitHead) return
  throw new Error(
    `release-patch: registry gitHead ${registryGitHead} for ${packageName}@${version} does not exactly match the ` +
    `operator's expected baseline ${expectedGitHead}; refusing to trust publisher-supplied provenance or create a tag.`
  )
}

/**
 * @param {{tag: string, version: {major: number, minor: number, patch: number}} | null} latest Latest tag.
 * @param {{major: number, minor: number, patch: number}} requestedVersion Requested parsed version.
 * @param {string} version Requested string version.
 */
function ensureReconciliationFollowsLatest(latest, requestedVersion, version) {
  if (latest === null) throwInvalidReconciliationSequence(version, "none")
  if (compareVersions(latest.version, requestedVersion) === 0) return
  if (deriveNextPatchVersion(latest.version) === version) return
  throwInvalidReconciliationSequence(version, latest.tag)
}

/**
 * @param {string} version Requested version.
 * @param {string} latestTag Latest tag.
 * @returns {never} Always throws.
 */
function throwInvalidReconciliationSequence(version, latestTag) {
  throw new Error(
    `release-patch: --reconcile-published ${version} must be exactly one patch after the latest annotated release ` +
    `tag (${latestTag}); refusing to fill an ambiguous gap or rewrite release history.`
  )
}

/**
 * Runs a normal patch release derived from tags. The latest annotated tag must already be on npm — a
 * tagged-but-unpublished latest tag blocks with instructions to use `--resume` rather than being
 * silently skipped. When the latest tag is published, the next patch is derived and preflighted, then
 * the version is bumped, dry-run-gated, committed, tagged, pushed and published.
 * @param {{version?: string, scripts?: Record<string, string>}} packageJson The validated manifest.
 * @param {string} packageName The validated package name.
 * @param {{tag: string, version: {major: number, minor: number, patch: number}} | null} latest The latest annotated release tag.
 */
function runNormalRelease(packageJson, packageName, latest) {
  if (latest === null) {
    throw new Error(
      "release-patch: could not find a valid vX.Y.Z release tag to derive the next version from. " +
      "To bootstrap a brand-new package, create an annotated tag matching package.json and HEAD and publish it " +
      "with --resume (for example: git tag -a v0.0.0 -m v0.0.0 && release-patch --resume)."
    )
  }

  const latestVersion = versionString(latest.version)

  // The latest tag is the released baseline; a normal release must never skip it. If it is not on
  // npm, block with instructions rather than derive a next version on top of an unpublished release.
  if (lookupPublishedVersion(`${packageName}@${latestVersion}`).trim() === "") {
    throw new Error(
      `release-patch: the latest release tag ${latest.tag} is not published on npm, so a normal release cannot ` +
      "derive the next version on top of it. Inspect why it is unpublished; if it was tagged but never published, " +
      `run \`release-patch --resume\` to publish exactly ${latest.tag}. Do not run a normal release until it is on npm.`
    )
  }

  const nextVersion = deriveNextPatchVersion(latest.version)
  const releaseTag = `v${nextVersion}`

  // Establish duplicate status for the exact next version before any mutation: only a definitive
  // registry "not found" continues; a duplicate or an uncertain lookup aborts before side effects.
  ensureVersionAvailable(packageName, nextVersion)

  // Capture the version manifests that exist on synced master *before* install or the version bump can
  // generate new ones, and the clean HEAD to roll back to if tag creation later fails. The working
  // tree is clean here (ensureCleanWorkingTree), so these are exactly the committed release inputs.
  const existingVersionManifests = existingVersionManifestFiles()
  const preReleaseHead = runCapture("git rev-parse --verify HEAD").trim()

  prepareLocalRelease(packageJson, nextVersion, releaseTag, existingVersionManifests, preReleaseHead)
  pushPreparedRelease(releaseTag)

  // Once the atomic push succeeds, recovery switches to --resume and local refs must be preserved.
  publishAndVerify(packageName, nextVersion, releaseTag)
}

/**
 * Builds and records the local release state, rolling every failure back before anything is pushed.
 * @param {{scripts?: Record<string, string>}} packageJson Package manifest.
 * @param {string} nextVersion Exact next version.
 * @param {string} releaseTag Exact release tag.
 * @param {string[]} existingVersionManifests Manifests eligible for the release commit.
 * @param {string} preReleaseHead Clean HEAD to restore on failure.
 */
function prepareLocalRelease(packageJson, nextVersion, releaseTag, existingVersionManifests, preReleaseHead) {
  try {
    installDependencies()
    run(`npm version ${nextVersion} --no-git-tag-version`)
    runExplicitBuildIfNeeded(packageJson)
    run("npm publish --dry-run")
    ensureOnlyVersionManifestsChanged(existingVersionManifests)
    commitVersionFiles(existingVersionManifests)
    ensureNoStrayReleaseChanges()
    run(`git tag -a ${releaseTag} -m ${releaseTag}`)
  } catch (error) {
    rollbackLocalReleaseState(releaseTag, preReleaseHead, error)
  }
}

/**
 * Attempts the atomic release push while preserving exact local state on an ambiguous push error.
 * @param {string} releaseTag Exact prepared release tag.
 */
function pushPreparedRelease(releaseTag) {
  try {
    run(`git push --atomic origin master ${releaseTag}`)
  } catch (error) {
    throw new Error(
      `release-patch: the atomic push for ${releaseTag} failed with an ambiguous remote outcome. The exact clean ` +
      "release commit and tag were preserved locally; run `release-patch --resume` to verify or push those same refs " +
      "and finish the release without bumping again.",
      {cause: error}
    )
  }
}

/**
 * Restores the exact clean pre-release checkout after any failure before the atomic release push.
 * Since the tree was proven clean beforehand, `git clean -fd` removes only non-ignored files emitted
 * by this attempt; ignored dependency/build output is harmless to the clean-tree preflight.
 * @param {string} releaseTag The not-remotely-pushed release tag, if it was created.
 * @param {string} preReleaseHead The clean synced HEAD before local release work.
 * @param {unknown} releaseError The original failure.
 * @returns {never} Always throws after rollback.
 */
function rollbackLocalReleaseState(releaseTag, preReleaseHead, releaseError) {
  try {
    if (gitSucceeds(["show-ref", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
      run(`git tag -d ${releaseTag}`)
    }
    run(`git reset --hard ${preReleaseHead}`)
    run("git clean -fd")
  } catch (rollbackError) {
    throw new Error(
      `release-patch: the release failed before its atomic push, and automatic cleanup also failed. No release refs ` +
      "were intentionally pushed or published. Resolve the reported Git cleanup failure before retrying the same command.",
      {cause: rollbackError}
    )
  }

  throw new Error(
    `release-patch: the release failed before its atomic push. Local version changes, release commit, tag and ` +
    `non-ignored generated files were rolled back to ${preReleaseHead}; rerun the exact same release-patch command ` +
    `after resolving the original failure. Original failure: ${errorMessage(releaseError)}`,
    {cause: releaseError}
  )
}

/**
 * @param {unknown} error Failure value.
 * @returns {string} Its diagnostic text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resumes a tagged-but-unpublished release. It publishes the exact existing latest annotated tag —
 * only when that tag points at the current synced master HEAD and package.json's version matches it
 * exactly — without bumping, committing or creating another tag. Already-published tags make resume a
 * verified no-op; otherwise the dependency, build and dry-run gates run, the exact master/tag is
 * pushed atomically (a no-op when already on origin), and the exact version is published and verified.
 * @param {{version?: string, scripts?: Record<string, string>}} packageJson The validated manifest.
 * @param {string} packageName The validated package name.
 * @param {{tag: string, version: {major: number, minor: number, patch: number}} | null} latest The latest annotated release tag.
 */
function runResume(packageJson, packageName, latest) {
  if (latest === null) {
    throw new Error(
      "release-patch: --resume needs an existing annotated vX.Y.Z release tag to publish, but none was found. " +
      "Create one matching package.json and HEAD first (for example: git tag -a v0.0.0 -m v0.0.0)."
    )
  }

  const version = versionString(latest.version)
  const releaseTag = latest.tag

  ensureResumeMatchesTaggedCommit(packageJson, releaseTag, version)

  // If the exact version is already on npm, resume is a verified no-op: make sure origin has the
  // refs (a no-op when already pushed) and confirm the published version, without republishing.
  if (lookupPublishedVersion(`${packageName}@${version}`).trim() !== "") {
    run(`git push --atomic origin master ${releaseTag}`)
    verifyPublished(packageName, version)

    return
  }

  installDependencies()
  runExplicitBuildIfNeeded(packageJson)
  run("npm publish --dry-run")

  // Install, build and the dry-run can regenerate a lockfile or emit tracked/non-ignored files. Before
  // pushing or publishing, require the tree to still exactly match the tagged commit so resume can
  // never ship a tree the tag does not record.
  ensureResumeTreeMatchesTag(releaseTag)

  pushPublishAndVerify(packageName, version, releaseTag)
}

/**
 * After resume's install, build and publish dry-run, refuses to push or publish unless the entire
 * non-ignored working tree still exactly matches the tagged commit. `ensureResumeMatchesTaggedCommit`
 * has already proven HEAD is the tagged commit, so an empty `git status --porcelain` means the tree
 * matches the tag; any tracked change or non-ignored untracked file means install, build or the
 * dry-run drifted the tree away from the tag and the release must not proceed.
 * @param {string} releaseTag The tag being resumed (`v<version>`), which HEAD is pinned to.
 */
function ensureResumeTreeMatchesTag(releaseTag) {
  const status = runCapture("git status --porcelain")

  if (status.trim() !== "") {
    throw new Error(
      `release-patch: after installing dependencies, building and running the publish dry-run, the working tree no ` +
      `longer matches the commit tagged ${releaseTag}. Refusing to push or publish a tree that differs from the tag. ` +
      "Install, the build or the dry-run modified tracked files or created non-ignored files; investigate and clean " +
      `these changes (or fix the tag) before resuming:\n${status.trim()}`
    )
  }
}

/**
 * Refuses a resume unless the tag it would publish is on the current master HEAD and the synced
 * package.json version matches it exactly, so resume can never publish a tree the tag does not record.
 * @param {{version?: string}} packageJson The validated manifest.
 * @param {string} releaseTag The tag to resume (`v<version>`).
 * @param {string} version The exact version the tag names.
 */
function ensureResumeMatchesTaggedCommit(packageJson, releaseTag, version) {
  const tagCommit = runCapture(`git rev-parse --verify ${releaseTag}^{commit}`).trim()
  const headCommit = runCapture("git rev-parse --verify HEAD").trim()

  if (tagCommit !== headCommit) {
    throw new Error(
      `release-patch: --resume can only publish ${releaseTag} when it points at the current master HEAD, but ` +
      `${releaseTag} is on ${tagCommit} while HEAD is ${headCommit}. Check out and sync the exact tagged commit, ` +
      "or run a normal release instead."
    )
  }

  if (packageJson.version !== version) {
    throw new Error(
      `release-patch: --resume requires package.json version (${packageJson.version ?? "unset"}) to exactly match ` +
      `the tag ${releaseTag}. Resume does not bump or commit — align package.json with the tag before resuming.`
    )
  }
}

/** Runs the release, choosing a normal patch release or a resume based on the CLI arguments. */
function main() {
  const {resume, reconcilePublished, expectedGitHead} = parseCliArgs(process.argv)

  // Refuse to run against a dirty tree before touching any branch, so stray edits can never leak into
  // the release commit and `git checkout master` can never clobber uncommitted work.
  ensureCleanWorkingTree()

  // Sync to the authoritative master before reading anything to publish, so the manifest we validate
  // and release is the fast-forwarded master, never stale feature-branch metadata carried across the sync.
  ensureLatestMaster()

  // Validate the manifest read from the synced master checkout; misconfiguration fails before any mutation.
  const packageJson = readValidatedPackageJson()
  const packageName = packageJson.name

  ensureNpmAuth()

  // Git tags are the source of truth. A normal release derives the next version from origin's
  // authoritative tag set, so it prunes local-only or stale tags and force-updates changed ones
  // before reading the latest tag; resume may publish a not-yet-pushed bootstrap tag, so it fetches
  // origin's tags without pruning the local ones.
  if (resume) {
    fetchTags()
    runResume(packageJson, packageName, latestAnnotatedReleaseTag())
  } else {
    fetchOriginAuthoritativeTags()
    const latest = latestAnnotatedReleaseTag()

    if (reconcilePublished !== undefined) {
      runReconciledRelease(packageJson, packageName, reconcilePublished, /** @type {string} */ (expectedGitHead), latest)
    } else {
      runNormalRelease(packageJson, packageName, latest)
    }
  }
}

try {
  main()
} catch (error) {
  process.exitCode = 1
  console.error(error instanceof Error ? error.message : String(error))
}
