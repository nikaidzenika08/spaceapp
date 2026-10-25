import { Writable } from "node:stream";

export function containerEngine(value = "docker") {
  if (value !== "docker" && value !== "podman") throw new Error("Engine must be docker or podman.");
  return value;
}

export function assertEngineSelection(requested, existing) {
  const engine = containerEngine(requested ?? existing?.engine);
  if (existing && engine !== containerEngine(existing.engine)) {
    throw new Error("Switching container engines on an existing installation is refused: Docker and Podman do not share volumes. Keep its configured engine and use a separate installation root for another engine.");
  }
  return engine;
}

// One boundary covers all lifecycle operations, including recovery/checkpoints and direct image probes.
// Do not translate arbitrary executable names or shell strings.
export function executeForEngine(execute, engine) {
  containerEngine(engine);
  if (engine === "docker") return execute;
  return (spec, io) => execute({
    ...spec,
    ...(spec.command === "docker" ? { command: "podman" } : {}),
    ...(["docker", "podman"].includes(spec.command) && spec.args?.[0] === "compose"
      ? { env: { ...spec.env, PODMAN_COMPOSE_PROVIDER: "docker-compose" } } : {})
  }, io);
}

async function capture(execute, command, args) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ command, args, timeoutMs: 15000 }, { stdin: null, stdout, stderr: null });
    return code === 0 ? output.trim() : null;
  } catch { return null; }
}

export async function detectContainerEngine(execute, { requested, existing, platform = process.platform } = {}) {
  if (requested !== undefined || existing) return assertEngineSelection(requested, existing);
  // A working Docker installation wins, even when Podman is also installed.
  if (await capture(execute, "docker", ["info", "--format", "{{json .}}"] ) !== null) return "docker";
  if (platform !== "win32" && /^podman version \d+\./i.test(await capture(execute, "podman", ["--version"]) ?? "")) return "podman";
  return "docker";
}

export function normalizeEngineInfo(info, engine = "docker") {
  if (!info || typeof info !== "object") return null;
  if (engine === "docker") return info;
  return { ...info, Architecture: info.host?.arch, NCPU: info.host?.cpus,
    MemTotal: info.host?.memTotal, DockerRootDir: info.store?.graphRoot };
}

export function podmanFacts(info, composeVersion) {
  return {
    engine: "podman", version: info?.version?.Version ?? null,
    composeVersion: composeVersion ?? null,
    rootless: info?.host?.security?.rootless ?? null,
    cgroupVersion: info?.host?.cgroupVersion ?? null,
    cgroupControllers: Array.isArray(info?.host?.cgroupControllers) ? info.host.cgroupControllers : [],
    cpuCount: info?.host?.cpus ?? null,
    memoryBytes: info?.host?.memTotal ?? null
  };
}

function versionAtLeast(value, major, minor) {
  const match = /^(?:Docker Compose version )?v?(\d+)\.(\d+)(?:\.|$)/.exec(value ?? "");
  return !!match && (+match[1] > major || +match[1] === major && +match[2] >= minor);
}

export async function inspectPodman(execute, { platform = process.platform, requirements } = {}) {
  execute = executeForEngine(execute, "podman");
  const raw = await capture(execute, "podman", ["info", "--format", "json"]);
  let info = null;
  try { info = JSON.parse(raw); } catch { /* Missing or stopped engines produce failed checks below. */ }
  const compose = await capture(execute, "podman", ["compose", "version", "--short"]);
  const facts = podmanFacts(info, compose);
  const checks = [
    { name: "Container engine", ok: platform === "linux" || platform === "darwin", detail: "Podman (Linux rootless or macOS machine; Windows unsupported)" },
    { name: "Podman version", ok: versionAtLeast(facts.version, 5, 0), detail: `${facts.version ?? "not reachable"}; requires Podman >= 5. Start Podman/machine before retrying.` },
    { name: "Podman Compose", ok: versionAtLeast(compose, 2, 20), detail: `${compose ?? "provider unavailable"}; requires docker-compose >= 2.20 on PATH (podman-compose is unsupported).` },
    { name: "Podman mode", ok: facts.rootless === true,
      detail: facts.rootless === null ? "unknown" : facts.rootless ? "rootless" : "rootful; use rootless Podman (macOS: podman machine stop; podman machine set --rootful=false; podman machine start)" },
    { name: "Podman cgroups", ok: facts.cgroupVersion === "v2", detail: `${facts.cgroupVersion ?? "unknown"}; requires cgroup v2` },
    { name: "Podman CPU/memory limits", ok: ["cpu", "memory"].every((name) => facts.cgroupControllers.includes(name)),
      detail: `Delegated controllers: ${facts.cgroupControllers.join(", ") || "none reported"}. CPU and memory must be delegated; use a systemd user session with Delegate=yes.` }
  ];
  if (requirements && info) {
    checks.push({ name: "Podman resources", ok: facts.cpuCount >= requirements.cpuCount && facts.memoryBytes >= requirements.memoryBytes,
      detail: `${facts.cpuCount} CPUs, ${Math.floor(facts.memoryBytes / 1024 ** 2)} MiB RAM available` });
  }
  if (platform === "darwin") {
    const rawMachine = await capture(execute, "podman", ["machine", "inspect"]);
    let machines = [];
    try { machines = JSON.parse(rawMachine); } catch {}
    // inspect without a name describes the default machine used by the launcher.
    const machine = Array.isArray(machines) && machines.length === 1 ? machines[0] : null;
    let connections = [];
    try { connections = JSON.parse(await capture(execute, "podman", ["system", "connection", "list", "--format", "json"])); } catch {}
    const active = Array.isArray(connections) ? connections.find(c => c.Default === true) : null;
    checks.push({ name: "Podman machine connection", ok: !!machine && active?.Name === machine.Name,
      detail: `${active?.Name ?? "unknown"}; use the default rootless machine connection: podman system connection default podman-machine-default` });
    facts.machine = machine ? { name: machine.Name, state: machine.State, cpuCount: machine.Resources?.CPUs,
      memoryMiB: machine.Resources?.Memory, diskGiB: machine.Resources?.DiskSize } : null;
    const r = facts.machine;
    checks.push({ name: "Podman machine", ok: !!r && r.state === "running" && (!requirements ||
      r.cpuCount >= requirements.cpuCount && r.memoryMiB * 1024 ** 2 >= requirements.memoryBytes && r.diskGiB * 1024 ** 3 >= requirements.freshDiskBytes),
      detail: `${r ? `${r.name}: ${r.state}, ${r.cpuCount} CPUs, ${r.memoryMiB} MiB RAM, ${r.diskGiB} GiB disk` : "default machine unavailable"}. Resize with podman machine stop; podman machine set --cpus N --memory MiB --disk-size GiB; podman machine start. Available disk is checked separately during installation.` });
  }
  return { facts, checks };
}

export async function ensurePodmanAvailable({ execute, platform, stdout, stderr, requirements }) {
  const result = await inspectPodman(execute, { platform, requirements });
  for (const check of result.checks) (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  return { code: result.checks.every((check) => check.ok) ? 0 : 1, reexecuted: false };
}

// The published images' entrypoints start as root, initialize named volumes, then drop to uid 10001.
// Use the SAME namespace for every service sharing those volumes, including the one-shot initializer.
// keep-id maps uid 10001 back to the invoking host user without chowning registered host workspaces.
export function renderEngineCompose(template, engine) {
  if (containerEngine(engine) === "docker") return template;
  return template.replace(/\r\n/g, "\n").replace(/(^  ([a-z][a-z0-9-]*):\n)([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|^\S|(?![\s\S]))/gm,
    (section, header, service, body) => {
      // Only transform service definitions, not network/volume definitions at the end of the template.
      if (!/^    image:/m.test(body)) return section;
      const secrets = [];
      body = body.replace(/^    secrets:\n((?:      - [a-z0-9-]+\n)+)/gm, (_block, entries) => {
        for (const match of entries.matchAll(/- ([a-z0-9-]+)/g)) secrets.push(`      - ./secrets/${match[1]}:/run/secrets/${match[1]}:ro,z\n`);
        return "";
      });
      // Compose file secrets are read-only file binds. Render them explicitly so shared SELinux labels apply too.
      if (secrets.length) body = /^    volumes:\n/m.test(body)
        ? body.replace(/^    volumes:\n/m, `    volumes:\n${secrets.join("")}`)
        : `${body}    volumes:\n${secrets.join("")}`;
      body = body.replace(/^(      - \.\/[^\n]+)$/gm, (line) => /:(?:ro|rw),z$/.test(line) ? line : /:(?:ro|rw)$/.test(line) ? `${line},z` : `${line}:z`);
      const user = /^    user:/m.test(body) ? "" : `    user: "${service === "temporal" ? "1000:1000" : "0:0"}"\n`;
      return `${header}    userns_mode: "keep-id:uid=10001,gid=10001"\n${user}${body}`;
    });
}
