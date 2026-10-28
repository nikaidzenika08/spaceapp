import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { assertEngineSelection, detectContainerEngine, executeForEngine, inspectPodman, renderEngineCompose } from "../src/container-engine.mjs";
import { addWorkspace, composeCommand, initializeInstallation, prepareInstallation, saveConfig, validateConfig, renderWorkspaceCompose } from "../src/index.mjs";
import { run } from "../src/cli.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

const GiB = 1024 ** 3;
const info = { version: { Version: "5.7.0" }, host: { arch: "amd64", cpus: 8, memTotal: 16 * GiB,
  security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] }, store: {} };
const resources = { cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 30 * GiB };
const answers = { confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false, purgeConfirm: "DELETE" };
function output() {
  let text = "";
  return { stream: new Writable({ write(c, _e, done) { text += c; done(); } }), text: () => text };
}
function fakeEngine({ docker = false, podman = true, data = info, compose = "2.40.0", calls = [] } = {}) {
  return async (spec, io = {}) => {
    calls.push(spec);
    if (spec.command === "docker") return docker ? 0 : 127;
    if (spec.command !== "podman" || !podman) return 127;
    let result = "";
    if (spec.args[0] === "--version") result = "podman version 5.7.0";
    else if (spec.args[0] === "info") result = JSON.stringify(data);
    else if (spec.args.slice(0, 2).join(" ") === "compose version") result = compose;
    else if (spec.args.slice(0, 2).join(" ") === "machine inspect") result = JSON.stringify([{ Name: "podman-machine-default", State: "running", Resources: { CPUs: 8, Memory: 16384, DiskSize: 50 } }]);
    else if (spec.args.slice(0, 3).join(" ") === "system connection list") result = JSON.stringify([{ Name: "podman-machine-default", Default: true }]);
    else if (spec.args.includes("pg_dump")) result = "-- PostgreSQL database dump\nSELECT 1;\n";
    else if (spec.args.includes("image")) result = `sha256:${"a".repeat(64)}`;
    else if (spec.args.includes("psql")) result = "1024";
    if (result) io.stdout?.write(result);
    return 0;
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = output(); const calls = [];
  const options = { env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux", stdout: out.stream, stderr: out.stream,
    stdin: Readable.from([]), execute: fakeEngine({ calls }), inspectResources: async () => resources,
    ensureDocker: async () => { throw new Error("Must not install Docker for Podman"); }, prepareDockerPath: async () => {}, sleep: async () => {},
    request: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null } }) };
  return { root, out, calls, options };
}

test("engine detection prefers healthy Docker; missing Docker falls back only to a real Podman CLI", async () => {
  assert.equal(await detectContainerEngine(fakeEngine({ docker: true })), "docker");
  assert.equal(await detectContainerEngine(fakeEngine(), { platform: "linux" }), "podman");
  assert.equal(await detectContainerEngine(fakeEngine({ podman: false })), "docker");
  assert.equal(await detectContainerEngine(async () => 0), "docker");
  assert.equal(await detectContainerEngine(fakeEngine(), { platform: "win32" }), "docker");
  assert.equal(await detectContainerEngine(() => { throw new Error("no probes for persisted engine"); }, { existing: { engine: "podman" } }), "podman");
  assert.throws(() => assertEngineSelection("podman", {}), /Switching container engines/);
  assert.throws(() => assertEngineSelection("docker", { engine: "podman" }), /do not share volumes/);
  assert.throws(() => assertEngineSelection("other"), /Engine must be/);
});

test("Podman prerequisites reject old versions, unsupported Compose and missing delegated limits", async () => {
  const valid = await inspectPodman(fakeEngine(), { platform: "linux" });
  assert.ok(valid.checks.every(c => c.ok));
  for (const [data, compose, failed] of [
    [{ ...info, version: { Version: "4.9.0" } }, "2.40.0", "Podman version"],
    [info, "1.0.6", "Podman Compose"],
    [info, "2.19.0", "Podman Compose"],
    [{ ...info, host: { ...info.host, security: { rootless: false } } }, "2.40.0", "Podman mode"],
    [{ ...info, host: { ...info.host, cgroupVersion: "v1" } }, "2.40.0", "Podman cgroups"],
    [{ ...info, host: { ...info.host, cgroupControllers: ["pids"] } }, "2.40.0", "Podman CPU/memory limits"]
  ]) {
    const result = await inspectPodman(fakeEngine({ data, compose }), { platform: "linux" });
    assert.equal(result.checks.find(c => c.name === failed).ok, false, failed);
  }
  const absent = await inspectPodman(fakeEngine({ podman: false }), { platform: "linux" });
  assert.ok(absent.checks.some(c => !c.ok));
});

test("macOS machine capacity is checked with actionable resizing help", async () => {
  const valid = await inspectPodman(fakeEngine(), { platform: "darwin", requirements: { cpuCount: 4, memoryBytes: 7 * GiB, freshDiskBytes: 6.5 * GiB } });
  assert.ok(valid.checks.every(c => c.ok));
  const result = await inspectPodman(fakeEngine(), { platform: "darwin", requirements: { cpuCount: 16, memoryBytes: 20 * GiB, freshDiskBytes: 60 * GiB } });
  const machine = result.checks.find(c => c.name === "Podman machine");
  assert.equal(machine.ok, false);
  assert.match(machine.detail, /podman machine set --cpus/);
  assert.equal(result.facts.machine.diskGiB, 50);
  const execute = fakeEngine();
  const other = await inspectPodman((spec, io) => {
    if (spec.args.slice(0, 3).join(" ") === "system connection list") { io.stdout.write('[{"Name":"other","Default":true}]'); return 0; }
    return execute(spec, io);
  }, { platform: "darwin" });
  assert.equal(other.checks.find(c => c.name === "Podman machine connection").ok, false);
});

test("every Compose action retains its arguments when routed to Podman, including stdin and timeouts", async () => {
  const root = join(tmpdir(), "engine-actions");
  const actions = ["up", "down", "status", "logs", "pull", "backup", "restore", "pauseWriters", "unpauseWriters", "purge", "repair", "ensureCheckpointDatabase", "checkpointDump", "checkpointRestore", "installProvider", "rotateOwnerSetupToken", "syncCredentials"];
  for (const profile of ["small", "medium", "large"]) for (const action of actions) {
    const options = { profile, provider: "opencode", backupId: "spaceapp-backup-20261026T000000000Z" };
    const docker = composeCommand(action, root, options);
    const podman = composeCommand(action, root, { ...options, engine: "podman" });
    assert.equal(podman.command, "podman"); assert.deepEqual(podman.args, docker.args);
    const io = { input: Buffer.from("private stdin") };
    await executeForEngine(async (spec, received) => {
      assert.equal(spec.command, "podman"); assert.deepEqual(spec.args, docker.args);
      assert.equal(spec.timeoutMs, 1234); assert.equal(received, io);
      assert.equal(spec.env.PODMAN_COMPOSE_PROVIDER, "docker-compose");
    }, "podman")({ ...docker, timeoutMs: 1234 }, io);
  }
});

test("engine switching and host-root refusal leave existing credentials and config untouched", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.7", profile: "small" });
  const before = await readFile(join(f.root, "config.json"));
  const secret = await readFile(join(f.root, "secrets", "session-secret"));
  await assert.rejects(prepareInstallation(f.root, { version: "1.1.8", engine: "podman" }), /Switching container engines/);
  assert.deepEqual(await readFile(join(f.root, "config.json")), before);
  assert.deepEqual(await readFile(join(f.root, "secrets", "session-secret")), secret);
  await assert.rejects(run(["install", "--engine", "podman", "--non-interactive", "--answers", JSON.stringify(answers)], f.options), /Switching container engines/);
  assert.equal(f.calls.length, 0);
  const config = JSON.parse(before);
  assert.throws(() => validateConfig({ ...config, engine: "podman", accessMode: "host-root" }), /does not support --access host-root/);
});

for (const mode of ["flag", "answers", "auto"]) test(`noninteractive Podman install (${mode}) persists engine without installing Docker`, async (t) => {
  const f = await fixture(t);
  const argv = ["install", "--non-interactive", "--answers", JSON.stringify({ ...answers, ...(mode === "answers" ? { engine: "podman" } : {}) })];
  if (mode === "flag") argv.push("--engine=podman");
  assert.equal(await run(argv, f.options), 0, f.out.text());
  const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  const runtime = f.calls.filter(c => c.args.includes("--project-name"));
  assert.ok(runtime.some(c => c.args.includes("up")));
  assert.ok(runtime.every(c => c.command === "podman"));
});

test("SELinux mounts are shared and keep-id is consistent across services and initializers", async (t) => {
  const f = await fixture(t);
  const initialized = await initializeInstallation(f.root, { version: "1.1.7", profile: "large", engine: "podman" });
  const workspace = join(f.root, "rw"); await mkdir(workspace);
  await mkdir(join(f.root, "readonly"));
  let config = await addWorkspace(initialized.config, workspace);
  config = await addWorkspace(config, join(f.root, "readonly"), { readOnly: true });
  const overlay = renderWorkspaceCompose(config);
  assert.equal((overlay.match(/selinux: z/g) ?? []).length, 4);
  assert.match(overlay, /read_only: true/); assert.match(overlay, /read_only: false/);
  const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
  const rendered = renderEngineCompose(template, "podman");
  assert.equal((rendered.match(/userns_mode:/g) ?? []).length, 4);
  assert.match(rendered, /codex-sessions-init:\n    userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(rendered, /\.\/secrets\/database-url:\/run\/secrets\/database-url:ro,z/);
  assert.match(rendered, /\.\/backups:\/backups:z/);
  assert.match(rendered, /required: false/); assert.match(rendered, /condition: service_healthy/);
  assert.equal(renderEngineCompose(template, "docker"), template);
  assert.doesNotMatch(rendered, /:U(?:\s|$)/);
  for (const service of ["postgres", "temporal", "codex-lb", "headroom"]) {
    const section = rendered.split(`\n  ${service}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n|\n\S/)[0];
    assert.doesNotMatch(section, /^    (?:user|userns_mode):/m, service);
  }
  assert.match(rendered, /spaceapp-core:\n    userns_mode: "keep-id:uid=10001,gid=10001"\n    user: "0:0"/);
  // A replacement image must not inherit the first-party entrypoint assumptions.
  const replaced = renderEngineCompose(template.replace("ghcr.io/oll4com/spaceapp-core:", "example.com/other/core:"), "podman");
  assert.doesNotMatch(replaced.split("  spaceapp-core:\n")[1].split("\n  spaceapp-cli:")[0], /^    (?:user|userns_mode):/m);
});

test("Docker installs and refreshes omit the engine key for older launcher compatibility", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.7", profile: "small", engine: "docker" });
  const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(config, "engine"), false);
  await saveConfig(f.root, { ...config, engine: "docker" });
  const prepared = await prepareInstallation(f.root, { version: "1.1.7", engine: "docker" });
  assert.equal(Object.hasOwn(prepared.config, "engine"), false);
});

test("declining the interactive Podman offer continues the Docker installation", async (t) => {
  const f = await fixture(t);
  const stdin = Readable.from(["n\n"]);
  stdin.isTTY = true; stdin.setRawMode = () => {};
  let dockerSetup = false;
  const execute = fakeEngine({ docker: true, calls: f.calls });
  const code = await run(["install", "--answers", JSON.stringify(answers)], {
    ...f.options, stdin,
    execute: (spec, io) => spec.command === "docker" && spec.args[0] === "info" ? 127 : execute(spec, io),
    ensureDocker: async () => { dockerSetup = true; return { code: 0, reexecuted: false }; }
  });
  assert.equal(code, 0, f.out.text());
  assert.equal(dockerSetup, true);
  assert.ok(f.calls.some(c => c.command === "docker" && c.args.includes("up")));
  assert.ok(f.calls.every(c => c.command !== "podman" || c.args[0] === "--version"));
  const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(config, "engine"), false);
  assert.match(f.out.text(), /Container engine: docker/);
  assert.doesNotMatch(f.out.text(), /Container engine: Podman/);
});

for (const profile of ["small", "medium", "large"]) test(`${profile}: persisted Podman reaches lifecycle, doctor and support bundle without Docker`, async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.7", profile, engine: "podman" });
  for (const args of [["status"], ["logs"], ["up"], ["down"], ["provider", "install", "opencode"], ["doctor"], ["doctor", "--fix"], ["backup"], ["uninstall"]]) {
    assert.equal(await run([...args, "--non-interactive", "--answers", JSON.stringify(answers)], { ...f.options, stdin: Readable.from([]) }), 0, `${args}: ${f.out.text()}`);
  }
  const bundle = join(f.root, "support.json");
  assert.equal(await run(["support-bundle", "--out", bundle], f.options), 0);
  const report = JSON.parse(await readFile(bundle, "utf8"));
  assert.deepEqual(report.containerEngine.cgroupControllers, ["cpu", "memory", "pids"]);
  assert.equal(report.containerEngine.rootless, true);
  assert.equal(await run(["uninstall", "--purge-data", "--non-interactive", "--answers", JSON.stringify(answers)], f.options), 0);
  assert.ok(f.calls.length > 10);
  assert.ok(f.calls.every(c => c.command === "podman"), "persisted engine must cover all runtime probes and operations");
});

test("Podman storage uses remote engine resources and accepts native image IDs", async (t) => {
  const f = await fixture(t);
  const installed = await initializeInstallation(f.root, { version: "1.1.7", profile: "small", engine: "podman" });
  const plan = await inspectStoragePlan({ root: f.root, config: installed.config, resources, operation: "fresh", execute: fakeEngine() });
  assert.equal(plan.missingImageBytes, 0);
  assert.equal(plan.resources.engineCpuCount, 8);
  assert.equal(plan.resources.engineMemoryBytes, 16 * GiB);
});

test("Podman update checkpoints, rollback and restore keep the configured engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.7", profile: "small", engine: "podman" });
  const unattended = ["--non-interactive", "--answers", JSON.stringify(answers)];
  assert.equal(await run(["update", "1.1.8", ...unattended], f.options), 0, f.out.text());
  const checkpoints = await readdir(join(f.root, "checkpoints"));
  assert.equal(checkpoints.length, 1);
  const updated = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(updated.engine, "podman"); assert.equal(updated.previousVersion, "1.1.7");
  assert.ok(f.calls.some(c => c.args.includes("pg_dump")));
  assert.equal(await run(["rollback", ...unattended], f.options), 0, f.out.text());
  assert.equal(JSON.parse(await readFile(join(f.root, "config.json"), "utf8")).version, "1.1.7");
  await mkdir(join(f.root, "backups", "spaceapp-backup-20261026T000000000Z"));
  assert.equal(await run(["restore"], { ...f.options, stdin: Readable.from(["RESTORE\n"]) }), 0, f.out.text());
  assert.ok(f.calls.some(c => c.args.includes("scripts/portable-restore.mjs")));
  assert.ok(f.calls.every(c => c.command === "podman"));
});
