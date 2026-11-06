// Must stay in sync with the max-width media query that applies the mobile
// fixed layout for #root in index.css.
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

/**
 * Returns the visual-viewport offset that #root may use as its top inset.
 *
 * #root only consumes the offset in the mobile fixed layout, and native shells
 * already pin it at 0. Writing a non-zero offset from any other layout lets a
 * value measured in landscape survive the return to portrait and shift the
 * whole page down.
 */
export function computeViewportOffsetTop(
  isNativeShell: boolean,
  mobileLayout: boolean,
  visualViewportOffsetTop: number | null | undefined,
): number {
  if (isNativeShell || !mobileLayout) {
    return 0;
  }
  const offsetTop = Number(visualViewportOffsetTop);
  if (!Number.isFinite(offsetTop) || offsetTop <= 0) {
    return 0;
  }
  return offsetTop;
}
