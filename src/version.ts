import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

function findPackageJson(startDir: string): string {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      if (dir === root) throw new Error("package.json not found");
      dir = dirname(dir);
    }
  }
}

const manifest = JSON.parse(
  readFileSync(findPackageJson(dirname(fileURLToPath(import.meta.url))), "utf8"),
) as { version: string };

export const version = manifest.version;
