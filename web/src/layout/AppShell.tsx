import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  classifySwipeIntent,
  clamp01,
  drawerSwipeStartSide,
  horizontalPanAvailable,
  swipeProgress,
  swipeRelease,
  type SidebarSide,
  type SwipeDragMode,
} from "../services/edgeSwipe";
import {
  SIDEBAR_MAIN_MIN_WIDTH,
  clampSidebarWidth,
  clearStoredSidebarWidth,
  defaultSidebarWidth,
  readStoredSidebarWidth,
  resizedSidebarWidth,
  writeStoredSidebarWidth,
  type ResizableSidebarKind,
} from "./sidebarWidth";

type AppShellProps = {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  rightSidebar?: React.ReactNode;
  footer: React.ReactNode;
  drawer?: React.ReactNode;
  leftOpen?: boolean;
  rightOpen?: boolean;
  onCloseLeft?: () => void;
  onCloseRight?: () => void;
  onOpenLeft?: () => void;
  onOpenRight?: () => void;
  sidebarsSwapped?: boolean;
  fileSidebarFontScale?: number;
  mainFontScale?: number;
  sessionSidebarFontScale?: number;
};

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;
const MOBILE_SIDEBAR_WIDTH = "min(85vw, 360px)";

function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      setIsMobile(width < MOBILE_BREAKPOINT);
      setIsTablet(width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile, isTablet, viewportWidth };
}

const sidebarStyle: React.CSSProperties = {
  gridArea: "sidebar",
  borderRight: "1px solid var(--border-color)",
  overflow: "auto",
  background: "var(--mindfs-topbar-bg, var(--sidebar-bg))",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
  minWidth: 0,
};

const mainStyle: React.CSSProperties = {
  gridArea: "main",
  overflow: "hidden",
  padding: "0",
  background: "var(--mindfs-topbar-bg, var(--mobile-overlay-bg, var(--content-bg)))",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  position: "relative",
  zIndex: 1,
  contain: "paint",
};

const rightStyle: React.CSSProperties = {
  gridArea: "right",
  borderLeft: "1px solid var(--border-color)",
  overflow: "auto",
  background: "var(--mindfs-topbar-bg, var(--sidebar-bg))",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
  minWidth: 0,
};

const footerStyle: React.CSSProperties = {
  gridArea: "footer",
  borderTop: "none",
  padding: "0",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  background: "var(--mindfs-topbar-bg, var(--mobile-overlay-bg, var(--content-bg)))",
  zIndex: 100,
  minWidth: 0,
};

type DrawerDrag = {
  side: SidebarSide;
  mode: SwipeDragMode;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  velocity: number;
  active: boolean;
  el: HTMLElement;
  // Nearest horizontal scroller under the start point; it keeps the pan while
  // it can still scroll in the finger direction.
  scroller: HTMLElement | null;
};

type SidebarResizeDrag = {
  side: SidebarSide;
  kind: ResizableSidebarKind;
  pointerId: number;
  startX: number;
  startWidth: number;
  availableWidth: number;
  currentWidth: number;
  moved: boolean;
};

const RAIL_CLICK_DELAY_MS = 280;
const RAIL_DOUBLE_CLICK_REVERT_MS = 700;

function sidebarStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function mobileSidebarPixelWidth(): number {
  if (typeof window === "undefined") {
    return 360;
  }
  return Math.min(window.innerWidth * 0.85, 360);
}

// 选中文本时不启动抽屉手势：此时横向拖动是在扩选/拖动选区（iOS 长按选词
// 后再拖动尤其常见），不是侧滑。输入框/textarea 的选区不进 window.getSelection，
// 单独看活动控件的 selectionStart/End；光标收起（start === end）不算选中。
function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    return true;
  }
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    return active.selectionStart !== active.selectionEnd;
  }
  if (active instanceof HTMLInputElement) {
    return (
      active.selectionStart !== null &&
      active.selectionEnd !== null &&
      active.selectionStart !== active.selectionEnd
    );
  }
  return false;
}

export function AppShell({
  sidebar,
  main,
  rightSidebar,
  footer,
  drawer,
  leftOpen = true,
  rightOpen = true,
  onCloseLeft,
  onCloseRight,
  onOpenLeft,
  onOpenRight,
  sidebarsSwapped = false,
  fileSidebarFontScale = 1,
  mainFontScale = 1,
  sessionSidebarFontScale = 1,
}: AppShellProps) {
  const { t } = useI18n();
  const { isMobile, isTablet, viewportWidth } = useResponsive();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DrawerDrag | null>(null);
  const touchDragIdRef = useRef<number | null>(null);
  const dragProgressRef = useRef(0);
  const suppressClickUntilRef = useRef(0);
  const [dragPreview, setDragPreview] = useState<{ side: SidebarSide; progress: number } | null>(null);
  const sidebarResizeRef = useRef<SidebarResizeDrag | null>(null);
  const railClickTimersRef = useRef<Partial<Record<SidebarSide, number>>>({});
  const railToggleAtRef = useRef<Partial<Record<SidebarSide, number>>>({});
  const suppressRailClickUntilRef = useRef(0);
  const [resizingSide, setResizingSide] = useState<SidebarSide | null>(null);
  const [sidebarWidthOverrides, setSidebarWidthOverrides] = useState<
    Partial<Record<ResizableSidebarKind, number>>
  >(() => {
    const storage = sidebarStorage();
    const file = readStoredSidebarWidth(storage, "file");
    const session = readStoredSidebarWidth(storage, "session");
    return {
      ...(file !== undefined ? { file } : {}),
      ...(session !== undefined ? { session } : {}),
    };
  });

  // 清空抽屉手势的暂存状态。手指离开屏幕的正常路径会自己清；这个入口留给
  // 系统抢走触摸流（无 touchend）的异常路径——iOS PWA 切后台/锁屏时很常见。
  const resetDrawerGesture = useCallback(() => {
    dragRef.current = null;
    touchDragIdRef.current = null;
    dragProgressRef.current = 0;
    suppressClickUntilRef.current = 0;
    setDragPreview(null);
  }, []);

  // 手势中途被系统打断后，dragRef 若残留会挡住后续所有 touchstart（包括
  // 边缘拉开和抽屉内收起），遮罩的点击也会被判定为「拖拽进行中」而失灵。
  // 后台/恢复、可见性变化时一律清场，回到前台后手势可用。
  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const onHide = () => resetDrawerGesture();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetDrawerGesture();
      }
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isMobile, resetDrawerGesture]);

  // 拖拽中跨过 768px 断点（旋转/分屏）：桌面分支没有 pointer 处理器，
  // 不清场会让 dragRef 永久卡死、手势整体失效
  useEffect(() => {
    resetDrawerGesture();
    // The resize rails unmount below the mobile breakpoint, so a drag that
    // crosses it may never receive pointerup and would leave the body cursor
    // and the disabled grid transition behind.
    sidebarResizeRef.current = null;
    setResizingSide(null);
  }, [isMobile, resetDrawerGesture]);

  useEffect(() => {
    if (!rightSidebar) {
      sidebarResizeRef.current = null;
      setResizingSide(null);
    }
  }, [rightSidebar]);

  useEffect(() => {
    if (!resizingSide) {
      return;
    }
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [resizingSide]);

  useEffect(() => () => {
    for (const timer of Object.values(railClickTimersRef.current)) {
      window.clearTimeout(timer);
    }
    railClickTimersRef.current = {};
  }, []);

  const physicalLeftKind: ResizableSidebarKind = sidebarsSwapped ? "session" : "file";
  const physicalRightKind: ResizableSidebarKind = sidebarsSwapped ? "file" : "session";
  const leftDefaultWidth = defaultSidebarWidth(physicalLeftKind, isTablet);
  const rightDefaultWidth = defaultSidebarWidth(physicalRightKind, isTablet);
  const rawLeftWidth = sidebarWidthOverrides[physicalLeftKind] ?? leftDefaultWidth;
  const rawRightWidth = rightSidebar
    ? sidebarWidthOverrides[physicalRightKind] ?? rightDefaultWidth
    : 0;
  const physicalLeftOpen = sidebarsSwapped ? rightOpen : leftOpen;
  const physicalRightOpen = sidebarsSwapped ? leftOpen : rightOpen;
  const physicalLeftAvailableWidth =
    viewportWidth - (physicalRightOpen ? rawRightWidth : 0) - SIDEBAR_MAIN_MIN_WIDTH;
  const physicalLeftWidth = clampSidebarWidth(rawLeftWidth, physicalLeftAvailableWidth);
  const physicalRightAvailableWidth =
    viewportWidth - (physicalLeftOpen ? physicalLeftWidth : 0) - SIDEBAR_MAIN_MIN_WIDTH;
  const physicalRightWidth = rightSidebar
    ? clampSidebarWidth(rawRightWidth, physicalRightAvailableWidth)
    : 0;
  const physicalLeftWidthPx = `${physicalLeftWidth}px`;
  const physicalRightWidthPx = `${physicalRightWidth}px`;
  const mobileHeight = "var(--mindfs-viewport-height, 100dvh)";
  const physicalLeftContent = sidebarsSwapped ? rightSidebar : sidebar;
  const physicalRightContent = sidebarsSwapped ? sidebar : rightSidebar;
  const physicalLeftClose = sidebarsSwapped ? onCloseRight : onCloseLeft;
  const physicalLeftOpenHandler = sidebarsSwapped ? onOpenRight : onOpenLeft;
  const physicalRightClose = sidebarsSwapped ? onCloseLeft : onCloseRight;
  const physicalRightOpenHandler = sidebarsSwapped ? onOpenLeft : onOpenRight;
  const physicalLeftLabel = sidebarsSwapped ? t("sidebar.session") : t("sidebar.file");
  const physicalRightLabel = sidebarsSwapped ? t("sidebar.file") : t("sidebar.session");
  const physicalLeftFontScale = sidebarsSwapped ? sessionSidebarFontScale : fileSidebarFontScale;
  const physicalRightFontScale = sidebarsSwapped ? fileSidebarFontScale : sessionSidebarFontScale;
  const fontScaleStyle = (scale: number): React.CSSProperties => ({
    "--mindfs-font-scale": scale,
  } as React.CSSProperties);

  const availableWidthForSide = (side: SidebarSide): number => {
    const otherRawWidth = side === "left" ? rawRightWidth : rawLeftWidth;
    const otherOpen = side === "left" ? physicalRightOpen : physicalLeftOpen;
    return viewportWidth - (otherOpen ? otherRawWidth : 0) - SIDEBAR_MAIN_MIN_WIDTH;
  };

  const resetSidebarWidth = (kind: ResizableSidebarKind) => {
    setSidebarWidthOverrides((prev) => {
      if (prev[kind] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    clearStoredSidebarWidth(sidebarStorage(), kind);
  };

  const beginSidebarResize =
    (side: SidebarSide, kind: ResizableSidebarKind, startWidth: number) =>
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      if (side === "left" ? !physicalLeftOpen : !physicalRightOpen) {
        return;
      }
      const pendingClick = railClickTimersRef.current[side];
      if (pendingClick !== undefined) {
        window.clearTimeout(pendingClick);
        delete railClickTimersRef.current[side];
      }
      sidebarResizeRef.current = {
        side,
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        availableWidth: availableWidthForSide(side),
        currentWidth: startWidth,
        moved: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; the rail still receives the stream.
      }
    };

  const moveSidebarResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = sidebarResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(deltaX) < 3) {
        return;
      }
      drag.moved = true;
      setResizingSide(drag.side);
    }
    event.preventDefault();
    const width = resizedSidebarWidth(
      drag.side,
      drag.startWidth,
      deltaX,
      drag.availableWidth,
    );
    drag.currentWidth = width;
    setSidebarWidthOverrides((prev) => {
      if (prev[drag.kind] === width) {
        return prev;
      }
      return { ...prev, [drag.kind]: width };
    });
  };

  const finishSidebarResize = (pointerId: number, persist: boolean) => {
    const drag = sidebarResizeRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return;
    }
    sidebarResizeRef.current = null;
    if (drag.moved) {
      suppressRailClickUntilRef.current = performance.now() + 250;
      if (persist) {
        writeStoredSidebarWidth(sidebarStorage(), drag.kind, drag.currentWidth);
      }
    }
    setResizingSide(null);
  };

  const togglePhysicalSidebar = (side: SidebarSide) => {
    if (side === "left") {
      (physicalLeftOpen ? physicalLeftClose : physicalLeftOpenHandler)?.();
    } else {
      (physicalRightOpen ? physicalRightClose : physicalRightOpenHandler)?.();
    }
  };

  const handleRailClick =
    (side: SidebarSide) => (event: React.MouseEvent<HTMLButtonElement>) => {
      if (performance.now() < suppressRailClickUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.detail === 0) {
        togglePhysicalSidebar(side);
        return;
      }
      const pendingClick = railClickTimersRef.current[side];
      if (pendingClick !== undefined) {
        window.clearTimeout(pendingClick);
      }
      railClickTimersRef.current[side] = window.setTimeout(() => {
        delete railClickTimersRef.current[side];
        railToggleAtRef.current[side] = performance.now();
        togglePhysicalSidebar(side);
      }, RAIL_CLICK_DELAY_MS);
    };

  const handleRailDoubleClick =
    (side: SidebarSide, kind: ResizableSidebarKind) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const pendingClick = railClickTimersRef.current[side];
      if (pendingClick !== undefined) {
        window.clearTimeout(pendingClick);
        delete railClickTimersRef.current[side];
      }
      // The platform double-click interval can exceed RAIL_CLICK_DELAY_MS, in
      // which case the first click already toggled the sidebar. Revert that
      // toggle so double-click only resets the width.
      const toggledAt = railToggleAtRef.current[side];
      if (
        toggledAt !== undefined &&
        performance.now() - toggledAt <= RAIL_DOUBLE_CLICK_REVERT_MS
      ) {
        delete railToggleAtRef.current[side];
        togglePhysicalSidebar(side);
      }
      resetSidebarWidth(kind);
    };

  const drawerProgress = (side: SidebarSide): number => {
    if (dragPreview && dragPreview.side === side) {
      return dragPreview.progress;
    }
    return (side === "left" ? physicalLeftOpen : physicalRightOpen) ? 1 : 0;
  };

  const drawerTransform = (side: SidebarSide): string => {
    const progress = drawerProgress(side);
    const offset = side === "left" ? (progress - 1) * 100 : (1 - progress) * 100;
    return `translateX(${offset.toFixed(2)}%) translateZ(0)`;
  };

  const shellStyle: React.CSSProperties & {
    "--mindfs-actionbar-bottom-padding"?: string;
    "--mindfs-file-menu-width"?: string;
  } = {
    display: isMobile ? "flex" : "grid",
    flexDirection: isMobile ? "column" : undefined,
    gridTemplateColumns: isMobile ? undefined : `${physicalLeftOpen ? physicalLeftWidthPx : "0px"} 1fr ${physicalRightOpen ? physicalRightWidthPx : "0px"}`,
    gridTemplateRows: isMobile ? undefined : "1fr auto",
    gridTemplateAreas: isMobile ? undefined : `"sidebar main right" "sidebar footer right"`,
    minHeight: isMobile ? mobileHeight : "100vh",
    height: isMobile ? mobileHeight : "100dvh",
    background: isMobile
      ? "var(--mindfs-topbar-bg, var(--mindfs-system-bar-bg, var(--mobile-overlay-bg, var(--content-bg))))"
      : "var(--bg-gradient-composite, var(--bg-gradient-start, #f3f4f6))",
    color: "var(--text-primary)",
    position: "relative",
    width: isMobile ? "100%" : undefined,
    maxWidth: isMobile ? "100%" : undefined,
    paddingTop: isMobile ? "var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px))" : undefined,
    overflow: "hidden",
    isolation: "isolate",
    boxSizing: "border-box",
    transition: resizingSide ? "none" : "grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    "--mindfs-actionbar-bottom-padding": "calc(var(--mindfs-safe-area-bottom) + 12px)",
    "--mindfs-file-menu-width": isMobile ? "min(240px, calc(100vw - 16px))" : "220px",
  };

  const mobileSidebarStyle = (side: SidebarSide): React.CSSProperties => {
    const progress = drawerProgress(side);
    const dragging = !!dragPreview && dragPreview.side === side;
    return {
      position: "fixed",
      top: "var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px))",
      bottom: 0,
      [side]: 0,
      width: MOBILE_SIDEBAR_WIDTH,
      zIndex: 2000,
      background: "var(--mindfs-topbar-bg, var(--mobile-sidebar-bg, var(--sidebar-bg)))",
      boxShadow: side === "left" ? "4px 0 24px rgba(0,0,0,0.15)" : "-4px 0 24px rgba(0,0,0,0.15)",
      transition: dragging
        ? "none"
        : "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), visibility 0.28s linear",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      borderTopRightRadius: side === "left" ? "14px" : undefined,
      borderBottomRightRadius: side === "left" ? "14px" : undefined,
      borderTopLeftRadius: side === "right" ? "14px" : undefined,
      borderBottomLeftRadius: side === "right" ? "14px" : undefined,
      willChange: "transform",
      backfaceVisibility: "hidden",
      transform: drawerTransform(side),
      // 关闭后移出命中测试与无障碍树；visibility 过渡保证展开瞬间恢复可见
      visibility: progress <= 0 && !dragging ? "hidden" : "visible",
      // touch-action 保持默认：竖向滚动与抽屉内横向滚动区（筛选 chips 等）继续
      // 走原生；横向手势由 touch 事件通道锁定意图后 preventDefault 接管，
      // 不依赖 touch-action——实测 auto/pan-y 在嵌套滚动结构下都会被浏览器抢发
      // pointercancel，touch 流才是抢不走的
      touchAction: "auto",
      pointerEvents: progress <= 0 && !dragging ? "none" : "auto",
    };
  };

  const overlayProgress = Math.max(drawerProgress("left"), drawerProgress("right"));
  const overlayDragging = !!dragPreview;
  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.3)",
    zIndex: 1500,
    opacity: clamp01(overlayProgress),
    pointerEvents: !overlayDragging && overlayProgress > 0.02 ? "auto" : "none",
    transition: overlayDragging ? "none" : "opacity 0.18s ease",
    willChange: "opacity",
    backfaceVisibility: "hidden",
    transform: "translateZ(0)",
    // 关掉双击缩放：点空白区域收起抽屉必须一次就中
    touchAction: "manipulation",
  };

  const endDrag = (decision: SwipeDragMode | null, side: SidebarSide) => {
    dragProgressRef.current = 0;
    setDragPreview(null);
    suppressClickUntilRef.current = performance.now() + 250;
    if (decision === "open") {
      (side === "left" ? physicalLeftOpenHandler : physicalRightOpenHandler)?.();
    } else if (decision === "close") {
      (side === "left" ? physicalLeftClose : physicalRightClose)?.();
    }
  };

  // 起点附近最近的可横向滚动容器（筛选 chips、代码块……）。归属在意图锁定
  // 为横向后才判定：还能顺着手指方向滚就还给原生滚动，已经滚到头则归抽屉。
  // 若在 touchstart 时直接放弃，「滚到头」就等于侧滑失灵——这正是边缘/抽屉
  // 手势在含代码块或 chips 的页面上「有时候拉不动」的来源。
  const findHorizontalScroller = (target: EventTarget | null, stop: HTMLElement): HTMLElement | null => {
    let el = target instanceof Element ? target : null;
    while (el && el !== stop && el !== document.body) {
      const styles = window.getComputedStyle(el);
      const scrollable =
        (styles.overflowX === "auto" || styles.overflowX === "scroll") &&
        el.scrollWidth > el.clientWidth + 1;
      if (scrollable && el instanceof HTMLElement) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  };

  // 手指已离开却没收到的 touchend/touchcancel（系统抢走触摸流、PWA 切后台、
  // 页面从后台恢复）：残留手势会挡住之后所有 touchstart，遮罩点击也会被当成
  // 「拖拽进行中」。新的触摸开始时顺手清掉。
  const healStaleDrawerDrag = (e: TouchEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      touchDragIdRef.current = null;
      return;
    }
    if (drag.pointerId === -1) {
      const tracked = touchDragIdRef.current;
      // identifier 会在不同手势间复用，不能只看 id：同一根手指还在拖时，
      // 新的 touchstart 的 touches 里必然已有它（多指时 length > 1）；单指
      // 的全新序列不可能和进行中的触屏拖拽并存。
      const trackedDown =
        tracked !== null && Array.from(e.touches).some((touch) => touch.identifier === tracked);
      if (trackedDown && e.touches.length > 1) {
        return;
      }
    } else if (drag.active) {
      return;
    }
    dragRef.current = null;
    touchDragIdRef.current = null;
    dragProgressRef.current = 0;
    setDragPreview(null);
  };

  const drawerPointerDown = (side: SidebarSide, fromEdge: boolean) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      // 触屏走 touch 事件通道（下方 drawerTouch* 系列）：pointer 流会被浏览器的
      // 滚动接管以 pointercancel 杀死（touch-action 只能救部分 DOM 结构，
      // 实测 pan-y 抽屉嵌滚动列表照样被杀），而 pointercancel 后 touch 流仍完整，
      // 锁定横向后 preventDefault 即可让浏览器永远抢不走手势。
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) {
      return;
    }
    if (hasActiveTextSelection()) {
      return;
    }
    const open = side === "left" ? physicalLeftOpen : physicalRightOpen;
    // Edge zones only open a closed drawer; the drawer body only closes an open one.
    if (fromEdge ? open : !open) {
      return;
    }
    if (dragRef.current && dragRef.current.active) {
      // 已成手势的拖拽只认一根手指；未激活的"预备态"允许新手指接管，
      // 防止触屏极少数吞事件场景把引擎卡死在武装态
      return;
    }
    dragRef.current = {
      side,
      mode: fromEdge ? "open" : "close",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      velocity: 0,
      active: false,
      el: e.currentTarget,
      scroller: findHorizontalScroller(e.target, e.currentTarget),
    };
    // 接管预备态时若原武装来自 touch 通道（pointerId=-1），同步清掉它的
    // identifier，否则笔/鼠标先抬指后 touch 通道被悬空 id 永久锁死（审查 P1）
    if (touchDragIdRef.current !== null) {
      touchDragIdRef.current = null;
    }
    // 0 是合法进度（拖满关闭），不能用兜底值区分「没拖过」
    dragProgressRef.current = fromEdge ? 0 : 1;
    // 这里不能抢 setPointerCapture：capture 会把后续 compat click 重定向到
    // 容器，抽屉内按钮的点击与热区下的轻点都会失灵；等手势激活后再接管
  };

  // 拖拽推进：指针/触摸两条通道共用的速度估计与进度回写
  const updateDragFromPoint = (drag: DrawerDrag, x: number, y: number) => {
    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) {
      const instant = (x - drag.lastX) / dt;
      drag.velocity = drag.velocity * 0.7 + instant * 0.3;
      drag.lastT = now;
      drag.lastX = x;
    }
    const progress = swipeProgress(drag.side, drag.mode, x - drag.startX, mobileSidebarPixelWidth());
    dragProgressRef.current = progress;
    setDragPreview({ side: drag.side, progress });
  };

  const drawerPointerMove = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      // 僵尸守卫（仅鼠标）：pointerup 被系统吞掉（如窗口失焦）后按钮已松开，
      // 继续留着会让下一次鼠标移动幽灵激活拖拽。
      // 触屏不能按 buttons 清场——不少安卓浏览器/WebView 的 touch move 不按规范
      // 上报 buttons（恒为 0），会把正常滑动误杀成"只能点不能滑"；
      // 触屏由 pointercancel 和 lostpointercapture 兜底，足够了。
      const pointerType = (e as { pointerType?: string }).pointerType;
      if (pointerType === "mouse" && (e as { buttons?: number }).buttons === 0) {
        dragRef.current = null;
        return;
      }
      const intent = classifySwipeIntent(dx, dy);
      if (intent === "vertical") {
        dragRef.current = null;
        return;
      }
      if (intent !== "horizontal") {
        return;
      }
      if (hasActiveTextSelection()) {
        // 选择手势刚刚建立了选区：这次横向拖动属于扩选，不接管
        dragRef.current = null;
        return;
      }
      if (drag.scroller && horizontalPanAvailable(drag.scroller, dx)) {
        // 内层横滚容器还能跟手：让给原生滚动
        dragRef.current = null;
        return;
      }
      drag.active = true;
      try {
        drag.el.setPointerCapture(e.pointerId);
      } catch {
        // capture unsupported; window listeners still receive the stream
      }
    }
    updateDragFromPoint(drag, e.clientX, e.clientY);
  };

  const drawerPointerUp = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (!drag.active) {
      // No overlay intercepts taps: leave the underlying control's native click alone.
      return;
    }
    if (hasActiveTextSelection()) {
      // 拖拽过程中建起了选区（长按扩选）：按取消处理，不切换抽屉
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
      return;
    }
    const progress = dragProgressRef.current;
    const openDirection = drag.side === "left" ? 1 : -1;
    const velocity = drag.velocity * openDirection;
    endDrag(swipeRelease(progress, velocity, mobileSidebarPixelWidth()), drag.side);
  };

  const drawerPointerCancel = (e: { pointerId: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (drag.active) {
      // snap back to the state-derived position without toggling
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
    }
  };

  // ---------- 触屏通道（touch events） ----------
  // pointer 流会被浏览器滚动接管 pointercancel 杀死；pointercancel 之后 touch 流
  // 依然完整送达，所以触屏拖拽从 touchmove 驱动：意图锁定横向后 preventDefault，
  // 浏览器既不敢滚也不敢 cancel。竖向意图立刻放手（不 preventDefault），原生滚动照旧。

  const drawerTouchStart = (side: SidebarSide, fromEdge: boolean, e: TouchEvent, host: HTMLElement) => {
    if (touchDragIdRef.current !== null || dragRef.current) {
      return;
    }
    if (hasActiveTextSelection()) {
      return;
    }
    const open = side === "left" ? physicalLeftOpen : physicalRightOpen;
    // 边缘热区只在关闭态拉开；抽屉本体只在展开态收起
    if (fromEdge ? open : !open) {
      return;
    }
    const touch = e.changedTouches[0];
    if (!touch) {
      return;
    }
    touchDragIdRef.current = touch.identifier;
    dragRef.current = {
      side,
      mode: fromEdge ? "open" : "close",
      pointerId: -1,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastT: performance.now(),
      velocity: 0,
      active: false,
      el: host,
      scroller: findHorizontalScroller(e.target, host),
    };
    // 0 是合法进度（拖满关闭），不能用兜底值区分「没拖过」
    dragProgressRef.current = fromEdge ? 0 : 1;
  };

  const drawerTouchMove = (e: TouchEvent) => {
    const drag = dragRef.current;
    const touchId = touchDragIdRef.current;
    if (!drag || drag.pointerId !== -1 || touchId === null) {
      return;
    }
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchId);
    if (!touch) {
      return;
    }
    const dx = touch.clientX - drag.startX;
    if (!drag.active) {
      const intent = classifySwipeIntent(dx, touch.clientY - drag.startY);
      if (intent === "vertical") {
        // 竖向：还给原生滚动，浏览器会发 pointercancel——touch 流不受影响，
        // 这里先自行清场即可
        dragRef.current = null;
        touchDragIdRef.current = null;
        return;
      }
      if (intent !== "horizontal") {
        return; // 8px 内未定意图，先不表态
      }
      if (hasActiveTextSelection()) {
        // 长按选词后建立的选区：横向拖动是在扩选，在 preventDefault 之前放手
        dragRef.current = null;
        touchDragIdRef.current = null;
        return;
      }
      if (drag.scroller && horizontalPanAvailable(drag.scroller, dx)) {
        // 内层横滚容器还能跟手：在 preventDefault 之前让给原生滚动
        dragRef.current = null;
        touchDragIdRef.current = null;
        return;
      }
      drag.active = true;
    }
    // 意图已锁定横向：吃掉整条手势，浏览器不许滚动、不许接管
    if (e.cancelable) {
      e.preventDefault();
    }
    updateDragFromPoint(drag, touch.clientX, touch.clientY);
  };

  const drawerTouchEnd = (e: TouchEvent, canceled: boolean) => {
    const drag = dragRef.current;
    const touchId = touchDragIdRef.current;
    if (!drag || drag.pointerId !== -1 || touchId === null) {
      return;
    }
    // 不依赖单条 changedTouches 记录来收尾：iOS 在系统抢走触摸流、切后台后
    // 可能不再给出匹配的 identifier，漏一次就会把 dragRef 永久卡在武装态。
    // 只要求「跟踪的手指已经不在 e.touches 里」或「所有手指都抬起了」。
    const oursEnded = Array.from(e.changedTouches).some((t) => t.identifier === touchId);
    const allUp = e.touches.length === 0;
    if (!oursEnded && !allUp) {
      return; // 抬起的是另一根手指，继续跟踪
    }
    dragRef.current = null;
    touchDragIdRef.current = null;
    if (!drag.active) {
      // 未成手势的轻点：一切交给原生 click（抽屉内按钮、热区下控件都不受伤）
      return;
    }
    if (canceled) {
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
      return;
    }
    if (hasActiveTextSelection()) {
      // 松手时选区已建立（长按选词/扩选与首次移动存在竞争）：不切换抽屉
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
      return;
    }
    const progress = dragProgressRef.current;
    const openDirection = drag.side === "left" ? 1 : -1;
    const velocity = drag.velocity * openDirection;
    endDrag(swipeRelease(progress, velocity, mobileSidebarPixelWidth()), drag.side);
  };

  const mobileFooterStyle: React.CSSProperties = {
    ...footerStyle,
    flexShrink: 0,
  };

  // move/up/cancel 挂在 window 上：capture 未接管前 touch 隐式捕获把事件发到
  // 原始目标，元素级监听会漏掉指针滑出元素的流
  const pointerHandlersRef = useRef({ move: drawerPointerMove, up: drawerPointerUp, cancel: drawerPointerCancel });
  useEffect(() => {
    pointerHandlersRef.current = { move: drawerPointerMove, up: drawerPointerUp, cancel: drawerPointerCancel };
  });

  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const onMove = (e: PointerEvent) => pointerHandlersRef.current.move(e);
    const onUp = (e: PointerEvent) => pointerHandlersRef.current.up(e);
    const onCancel = (e: PointerEvent) => pointerHandlersRef.current.cancel(e);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // lostpointercapture 不冒泡，必须用捕获阶段才能在 window 上收到
    window.addEventListener("lostpointercapture", onCancel, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("lostpointercapture", onCancel, true);
    };
  }, [isMobile]);

  // 触屏通道挂 document：touchstart/touchend 冒泡可达，touchmove 必须 non-passive
  // 才能 preventDefault（React 合成事件对 touchmove 是 passive 的，拦不住滚动）。
  // 处理器经 ref 间接调用，保证每次渲染用的都是最新 state（开合前提判定）。
  const drawerTouchStartFromEvent = (e: TouchEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const shell = shellRef.current;
    if (!target || !shell?.contains(target) || target.closest('[role="dialog"], [aria-modal="true"]')) {
      return;
    }
    // 每个新触摸先清理没有正常收尾的残留手势，再决定是否武装本次拖拽
    healStaleDrawerDrag(e);
    const host = target.closest<HTMLElement>("[data-drawer-touch]");
    if (!host) {
      if (physicalLeftOpen || physicalRightOpen) return;
      const touch = e.changedTouches[0];
      const side = touch && drawerSwipeStartSide(touch.clientX, window.innerWidth);
      if (side && (side === "left" ? physicalLeftContent : physicalRightContent)) {
        drawerTouchStart(side, true, e, shell);
      }
      return;
    }
    const side = host.getAttribute("data-drawer-touch") as SidebarSide | null;
    if (side !== "left" && side !== "right") {
      return;
    }
    drawerTouchStart(side, false, e, host);
  };
  const touchHandlersRef = useRef({
    start: drawerTouchStartFromEvent,
    move: drawerTouchMove,
    end: drawerTouchEnd,
  });
  useEffect(() => {
    touchHandlersRef.current = { start: drawerTouchStartFromEvent, move: drawerTouchMove, end: drawerTouchEnd };
  });

  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const onStart = (e: TouchEvent) => touchHandlersRef.current.start(e);
    const onMove = (e: TouchEvent) => touchHandlersRef.current.move(e);
    const onEnd = (e: TouchEvent) => touchHandlersRef.current.end(e, false);
    const onCancel = (e: TouchEvent) => touchHandlersRef.current.end(e, true);
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
      // 断点切换/卸载时清掉挂起的手势，防止拖拽状态卡死
      resetDrawerGesture();
    };
  }, [isMobile, resetDrawerGesture]);

  return (
    <div
      ref={shellRef}
      style={shellStyle}
      data-onboarding="shell"
      onPointerDown={isMobile ? (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest('[data-drawer-touch], [role="dialog"], [aria-modal="true"]')) return;
        if (physicalLeftOpen || physicalRightOpen) return;
        const side = drawerSwipeStartSide(e.clientX, window.innerWidth);
        if (side && (side === "left" ? physicalLeftContent : physicalRightContent)) {
          drawerPointerDown(side, true)(e);
        }
      } : undefined}
      onClickCapture={isMobile ? (e) => {
        if (performance.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      } : undefined}
    >
      {isMobile ? (
        <div
          style={overlayStyle}
          onClick={() => {
            if (dragRef.current?.active) {
              return;
            }
            onCloseLeft?.();
            onCloseRight?.();
          }}
        />
      ) : null}

      {physicalLeftContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={isMobile && drawerProgress("left") <= 0 ? true : undefined}
          data-drawer-touch={isMobile ? "left" : undefined}
          onPointerDown={isMobile ? drawerPointerDown("left", false) : undefined}
          onClickCapture={
            isMobile
              ? (e) => {
                  if (performance.now() < suppressClickUntilRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }
              : undefined
          }
          style={
            isMobile
              ? { ...mobileSidebarStyle("left"), ...fontScaleStyle(physicalLeftFontScale) }
              : {
                  ...sidebarStyle,
                  ...fontScaleStyle(physicalLeftFontScale),
                  overflow: physicalLeftOpen ? "auto" : "hidden",
                  pointerEvents: physicalLeftOpen ? "auto" : "none",
                }
          }
        >
          {physicalLeftContent}
        </aside>
      ) : null}

      <main
        className="mindfs-font-scale-region"
        data-mindfs-font-scale-region="main"
        style={
          isMobile
            ? {
                ...mainStyle,
                ...fontScaleStyle(mainFontScale),
                flex: 1,
                minHeight: 0,
                minWidth: 0,
              }
            : { ...mainStyle, ...fontScaleStyle(mainFontScale) }
        }
      >
        {main}
        {/* 将抽屉层放入主视图内部，确保绝对定位时能精准对齐主视图宽度 */}
        {drawer}
      </main>

      {physicalRightContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={isMobile && drawerProgress("right") <= 0 ? true : undefined}
          data-drawer-touch={isMobile ? "right" : undefined}
          onPointerDown={isMobile ? drawerPointerDown("right", false) : undefined}
          onClickCapture={
            isMobile
              ? (e) => {
                  if (performance.now() < suppressClickUntilRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }
              : undefined
          }
          style={
            isMobile
              ? { ...mobileSidebarStyle("right"), ...fontScaleStyle(physicalRightFontScale) }
              : {
                  ...rightStyle,
                  ...fontScaleStyle(physicalRightFontScale),
                  overflow: physicalRightOpen ? "auto" : "hidden",
                  pointerEvents: physicalRightOpen ? "auto" : "none",
                }
          }
        >
          {physicalRightContent}
        </aside>
      ) : null}

      {!isMobile ? (
        <>
          <button
            type="button"
            className={`mindfs-sidebar-resize-rail mindfs-sidebar-resize-rail--left${physicalLeftOpen ? " is-open" : " is-closed"}`}
            data-sidebar-resize="left"
            onClick={handleRailClick("left")}
            onDoubleClick={handleRailDoubleClick("left", physicalLeftKind)}
            onPointerDown={beginSidebarResize("left", physicalLeftKind, physicalLeftWidth)}
            onPointerMove={moveSidebarResize}
            onPointerUp={(event) => finishSidebarResize(event.pointerId, true)}
            onPointerCancel={(event) => finishSidebarResize(event.pointerId, true)}
            onLostPointerCapture={(event) => finishSidebarResize(event.pointerId, true)}
            aria-label={physicalLeftOpen ? t("sidebar.collapse", { label: physicalLeftLabel }) : t("sidebar.expand", { label: physicalLeftLabel })}
            title={`${physicalLeftOpen ? t("sidebar.collapse", { label: physicalLeftLabel }) : t("sidebar.expand", { label: physicalLeftLabel })} · ${t("sidebar.resizeHint")}`}
            style={{
              left: physicalLeftOpen ? `calc(${physicalLeftWidthPx} - 6px)` : 0,
              cursor: physicalLeftOpen ? "col-resize" : "e-resize",
            }}
          />
          {physicalRightContent ? (
            <button
              type="button"
              className={`mindfs-sidebar-resize-rail mindfs-sidebar-resize-rail--right${physicalRightOpen ? " is-open" : " is-closed"}`}
              data-sidebar-resize="right"
              onClick={handleRailClick("right")}
              onDoubleClick={handleRailDoubleClick("right", physicalRightKind)}
              onPointerDown={beginSidebarResize("right", physicalRightKind, physicalRightWidth)}
              onPointerMove={moveSidebarResize}
              onPointerUp={(event) => finishSidebarResize(event.pointerId, true)}
              onPointerCancel={(event) => finishSidebarResize(event.pointerId, true)}
              onLostPointerCapture={(event) => finishSidebarResize(event.pointerId, true)}
              aria-label={physicalRightOpen ? t("sidebar.collapse", { label: physicalRightLabel }) : t("sidebar.expand", { label: physicalRightLabel })}
              title={`${physicalRightOpen ? t("sidebar.collapse", { label: physicalRightLabel }) : t("sidebar.expand", { label: physicalRightLabel })} · ${t("sidebar.resizeHint")}`}
              style={{
                right: physicalRightOpen ? `calc(${physicalRightWidthPx} - 6px)` : 0,
                cursor: physicalRightOpen ? "col-resize" : "w-resize",
              }}
            />
          ) : null}
        </>
      ) : null}

      <footer
        className="mindfs-font-scale-region"
        data-mindfs-font-scale-region="main"
        style={
          isMobile
            ? { ...mobileFooterStyle, ...fontScaleStyle(mainFontScale) }
            : { ...footerStyle, ...fontScaleStyle(mainFontScale) }
        }
      >
        {footer}
      </footer>
    </div>
  );
}
