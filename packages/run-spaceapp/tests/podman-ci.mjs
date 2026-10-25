// Exercise the source launcher against an explicitly pinned, published runtime.
// Source candidates can precede publication of their image tags; this does not change production version selection.
import { run } from "../src/cli.mjs";

const runtimeVersion = process.env.SPACEAPP_CI_RUNTIME_VERSION;
if (!/^\d+\.\d+\.\d+$/.test(runtimeVersion ?? "")) throw new Error("Set SPACEAPP_CI_RUNTIME_VERSION to the published runtime under test.");
try {
  console.log(`Testing source launcher with published runtime ${runtimeVersion}`);
  process.exitCode = await run(process.argv.slice(2), { runtimeVersion });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
