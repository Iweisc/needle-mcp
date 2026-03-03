import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pacote from "pacote";
import type { Resource, ResolvedResource } from "./types.js";
import { createTempDir } from "./util/tmp.js";
import { logger } from "./util/log.js";

const execFileAsync = promisify(execFile);

export async function resolveResource(
  resource: Resource,
): Promise<ResolvedResource> {
  switch (resource.type) {
    case "local":
      return resolveLocal(resource.spec);
    case "npm":
      return resolveNpm(resource.spec);
    case "git":
      return resolveGit(resource.spec);
  }
}

async function resolveLocal(path: string): Promise<ResolvedResource> {
  await access(path);
  logger.info("Resolved local resource", { path });
  return { dir: path, cleanup: async () => {} };
}

async function resolveNpm(spec: string): Promise<ResolvedResource> {
  const { dir, cleanup } = await createTempDir();
  const dest = join(dir, "pkg");
  logger.info("Extracting npm package", { spec, dest });
  await pacote.extract(spec, dest);
  return { dir: dest, cleanup };
}

async function resolveGit(url: string): Promise<ResolvedResource> {
  const { dir, cleanup } = await createTempDir();
  const dest = join(dir, "repo");

  // Split URL#ref
  const hashIdx = url.indexOf("#");
  const repoUrl = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const ref = hashIdx >= 0 ? url.slice(hashIdx + 1) : undefined;

  logger.info("Cloning git repository", { repoUrl, ref, dest });
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--filter=blob:none", repoUrl, dest],
    { timeout: 60_000 },
  );

  if (ref) {
    await execFileAsync("git", ["checkout", ref], {
      cwd: dest,
      timeout: 30_000,
    });
  }

  return { dir: dest, cleanup };
}
