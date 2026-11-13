import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const LINUX_CANDIDATES = [
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

function windowsCandidates() {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  return roots.flatMap((root) => [
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
}

// Locate an installed Chromium-based browser without downloading one. Tests
// keep using playwright-core, which can drive system Chrome/Edge.
// Vite treats `port: 0` as "use the default port" (5173), which may already be
// occupied by a developer server. Ask the OS for a currently free port.
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function findBrowserExecutable() {
  const override = process.env.MINDFS_TEST_BROWSER;
  const candidates = [
    ...(override ? [override] : []),
    ...(process.platform === "darwin"
      ? MAC_CANDIDATES
      : process.platform === "win32"
        ? windowsCandidates()
        : LINUX_CANDIDATES),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installation.
    }
  }
  return "";
}
