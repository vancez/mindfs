export type ResizableSidebarKind = "file" | "session";
export type ResizableSidebarSide = "left" | "right";

export const SIDEBAR_WIDTH_STORAGE_KEYS: Record<ResizableSidebarKind, string> = {
  file: "mindfs-file-sidebar-width",
  session: "mindfs-session-sidebar-width",
};

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_MAIN_MIN_WIDTH = 320;

const DEFAULT_WIDTHS: Record<ResizableSidebarKind, { desktop: number; tablet: number }> = {
  file: { desktop: 260, tablet: 200 },
  session: { desktop: 280, tablet: 240 },
};

export function defaultSidebarWidth(
  kind: ResizableSidebarKind,
  isTablet: boolean,
): number {
  const widths = DEFAULT_WIDTHS[kind];
  return isTablet ? widths.tablet : widths.desktop;
}

export function clampSidebarWidth(width: number, availableWidth: number): number {
  const maxWidth = Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, Math.floor(availableWidth)),
  );
  const safeWidth = Number.isFinite(width) ? width : SIDEBAR_WIDTH_MIN;
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(safeWidth, maxWidth)));
}

export function resizedSidebarWidth(
  side: ResizableSidebarSide,
  startWidth: number,
  deltaX: number,
  availableWidth: number,
): number {
  const direction = side === "left" ? 1 : -1;
  return clampSidebarWidth(startWidth + deltaX * direction, availableWidth);
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem" | "removeItem">;

export function readStoredSidebarWidth(
  storage: StorageReader | null | undefined,
  kind: ResizableSidebarKind,
): number | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEYS[kind]);
    if (!raw) return undefined;
    const width = Number(raw);
    if (!Number.isFinite(width)) return undefined;
    return Math.round(width);
  } catch {
    return undefined;
  }
}

export function writeStoredSidebarWidth(
  storage: StorageWriter | null | undefined,
  kind: ResizableSidebarKind,
  width: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEYS[kind], String(Math.round(width)));
  } catch {
    // Storage may be unavailable (private mode, quota); resizing still works now.
  }
}

export function clearStoredSidebarWidth(
  storage: StorageWriter | null | undefined,
  kind: ResizableSidebarKind,
): void {
  if (!storage) return;
  try {
    storage.removeItem(SIDEBAR_WIDTH_STORAGE_KEYS[kind]);
  } catch {
    // Ignore storage failures; the in-memory default still applies.
  }
}
