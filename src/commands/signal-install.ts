import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { RuntimeEnv } from "../runtime.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR } from "../utils.js";

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type NamedAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

export type SignalInstallResult = {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
};

function looksLikeArchive(name: string): boolean {
  return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}

/**
 * Check whether a release asset name looks like a native/precompiled binary
 * (e.g. "Linux-native", "macos-native", "aarch64", "x86_64").
 */
function looksLikeNativeBinary(name: string): boolean {
  return /native|aarch64|x86_64|x86-64|arm64/.test(name.toLowerCase());
}

type PickedAsset = {
  asset: NamedAsset;
  /** Whether this is the platform-independent JVM archive (requires java). */
  isJvm: boolean;
};

function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): PickedAsset | undefined {
  const withName = assets.filter((asset): asset is NamedAsset =>
    Boolean(asset.name && asset.browser_download_url),
  );

  // Archives only, excluding signature files (.asc)
  const archives = withName.filter((a) => looksLikeArchive(a.name.toLowerCase()));

  const byName = (pattern: RegExp) =>
    archives.find((asset) => pattern.test(asset.name.toLowerCase()));

  const asNative = (a: NamedAsset | undefined) => (a ? { asset: a, isJvm: false } : undefined);
  const asJvm = (a: NamedAsset | undefined) => (a ? { asset: a, isJvm: true } : undefined);

  // On non-x64 architectures, native binaries (currently x86-64 only) will
  // fail with "Exec format error".  Prefer the platform-independent JVM
  // archive instead, which works on any architecture that has a JRE.
  const canRunNative = arch === "x64";

  if (platform === "linux") {
    if (canRunNative) {
      // x86-64: prefer native build, then any linux archive, then any archive
      return asNative(byName(/linux-native/) || byName(/linux/) || archives[0]);
    }
    // Non-x64 (aarch64, armv7, etc.): skip native builds, pick the
    // platform-independent JVM archive (the one without a platform tag).
    const jvmArchive = archives.find(
      (a) =>
        !looksLikeNativeBinary(a.name) &&
        !/(linux|macos|osx|darwin|windows|win)/.test(a.name.toLowerCase()),
    );
    return asJvm(jvmArchive) || asNative(byName(/linux/) || archives[0]);
  }

  if (platform === "darwin") {
    return asNative(byName(/macos|osx|darwin/) || archives[0]);
  }

  if (platform === "win32") {
    return asNative(byName(/windows|win/) || archives[0]);
  }

  return asNative(archives[0]);
}

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        if (!location || maxRedirects <= 0) {
          reject(new Error("Redirect loop or missing Location header"));
          return;
        }
        const redirectUrl = new URL(location, url).href;
        resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve).catch(reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function findSignalCliBinary(root: string): Promise<string | null> {
  const candidates: string[] = [];
  const enqueue = async (dir: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await enqueue(full, depth + 1);
      } else if (entry.isFile() && entry.name === "signal-cli") {
        candidates.push(full);
      }
    }
  };
  await enqueue(root, 0);
  return candidates[0] ?? null;
}

async function detectJava(): Promise<boolean> {
  try {
    const result = await runCommandWithTimeout(["java", "-version"], {
      timeoutMs: 5_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function installSignalCli(runtime: RuntimeEnv): Promise<SignalInstallResult> {
  if (process.platform === "win32") {
    return {
      ok: false,
      error: "Signal CLI auto-install is not supported on Windows yet.",
    };
  }

  const apiUrl = "https://api.github.com/repos/AsamK/signal-cli/releases/latest";
  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "openclaw",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `Failed to fetch release info (${response.status})`,
    };
  }

  const payload = (await response.json()) as ReleaseResponse;
  const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
  const assets = payload.assets ?? [];
  const picked = pickAsset(assets, process.platform, process.arch);
  const assetName = picked?.asset.name ?? "";
  const assetUrl = picked?.asset.browser_download_url ?? "";
  const isJvm = picked?.isJvm ?? false;

  if (!assetName || !assetUrl) {
    return {
      ok: false,
      error: "No compatible release asset found for this platform.",
    };
  }

  // The JVM archive is a shell-script wrapper that requires a Java runtime.
  // Bail early with a clear message rather than installing something unusable.
  if (isJvm) {
    const hasJava = await detectJava();
    if (!hasJava) {
      return {
        ok: false,
        error:
          `No native signal-cli build is available for ${process.arch}. ` +
          "The JVM-based archive requires Java (JRE 21+). " +
          "Install Java first (e.g. `sudo apt install default-jre`) and try again.",
      };
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-"));
  const archivePath = path.join(tmpDir, assetName);

  runtime.log(`Downloading signal-cli ${version} (${assetName})…`);
  await downloadToFile(assetUrl, archivePath);

  const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
  await fs.mkdir(installRoot, { recursive: true });

  if (assetName.endsWith(".zip")) {
    await runCommandWithTimeout(["unzip", "-q", archivePath, "-d", installRoot], {
      timeoutMs: 60_000,
    });
  } else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tgz")) {
    // JVM archives contain a top-level directory (signal-cli-VERSION/).
    // Strip it so contents land directly in installRoot, keeping the path
    // structure consistent with the native archive (which has no wrapper dir).
    const stripArgs = isJvm ? ["--strip-components=1"] : [];
    await runCommandWithTimeout(["tar", "-xzf", archivePath, "-C", installRoot, ...stripArgs], {
      timeoutMs: 60_000,
    });
  } else {
    return { ok: false, error: `Unsupported archive type: ${assetName}` };
  }

  const cliPath = await findSignalCliBinary(installRoot);
  if (!cliPath) {
    return {
      ok: false,
      error: `signal-cli binary not found after extracting ${assetName}`,
    };
  }

  await fs.chmod(cliPath, 0o755).catch(() => {});

  return { ok: true, cliPath, version };
}
