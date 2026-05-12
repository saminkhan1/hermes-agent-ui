'use strict';

const PET_WINDOW_WIDTH = 356;
const PET_WINDOW_HEIGHT = 320;
const PET_VIEWPORT_SIZE = { width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT };
const PET_DEFAULT_MARGIN = 24;
const PET_LAYOUT_PADDING = { top: 8, right: 28, bottom: 8, left: 0 };
const PET_TRAY_GAP = 4;
const PET_PLACEMENT_STICKINESS = 96;
const PET_DEFAULT_MASCOT_SIZE = { width: 112, height: 121 };
const PET_DEFAULT_TRAY_SIZE = { width: 276, height: 131 };

function rectCenterX(rect: LooseBoundaryValue) {
  return rect.x + rect.width / 2;
}

function rectCenterY(rect: LooseBoundaryValue) {
  return rect.y + rect.height / 2;
}

function pointForRectCenter(rect: LooseBoundaryValue) {
  return { x: rectCenterX(rect), y: rectCenterY(rect) };
}

function clampNumber(value: LooseBoundaryValue, min: LooseBoundaryValue, max: LooseBoundaryValue) {
  if (min > max) return Math.round((min + max) / 2);
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampRectToDisplay(rect: LooseBoundaryValue, displayBounds: LooseBoundaryValue, { bottomPadding = 0 } = {}) {
  return {
    ...rect,
    x: clampNumber(rect.x, displayBounds.x, displayBounds.x + displayBounds.width - rect.width),
    y: clampNumber(rect.y, displayBounds.y, displayBounds.y + displayBounds.height - rect.height - bottomPadding),
  };
}

function expandedMascotBounds(mascotBounds: LooseBoundaryValue) {
  return {
    x: mascotBounds.x - PET_LAYOUT_PADDING.left,
    y: mascotBounds.y - PET_LAYOUT_PADDING.top,
    width: mascotBounds.width + PET_LAYOUT_PADDING.left + PET_LAYOUT_PADDING.right,
    height: mascotBounds.height + PET_LAYOUT_PADDING.top + PET_LAYOUT_PADDING.bottom,
  };
}

function trayBoundsForPlacement(
  anchor: LooseBoundaryValue,
  traySize: LooseBoundaryValue,
  placement: LooseBoundaryValue,
) {
  const isTop = placement.startsWith('top');
  return {
    x: placement.endsWith('end') ? anchor.x + anchor.width - traySize.width : anchor.x,
    y: isTop ? anchor.y - traySize.height - PET_TRAY_GAP : anchor.y + anchor.height + PET_TRAY_GAP,
    width: traySize.width,
    height: traySize.height,
  };
}

function overflowScore(rect: LooseBoundaryValue, displayBounds: LooseBoundaryValue) {
  const left = Math.max(0, displayBounds.x - rect.x);
  const top = Math.max(0, displayBounds.y - rect.y);
  const right = Math.max(0, rect.x + rect.width - displayBounds.x - displayBounds.width);
  const bottom = Math.max(0, rect.y + rect.height - displayBounds.y - displayBounds.height);
  return left + top + bottom + right + (left + right) * rect.height + (top + bottom) * rect.width;
}

function unionRects(rects: LooseBoundaryValue) {
  const x = Math.min(...rects.map((rect: LooseBoundaryValue) => rect.x));
  const y = Math.min(...rects.map((rect: LooseBoundaryValue) => rect.y));
  const right = Math.max(...rects.map((rect: LooseBoundaryValue) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect: LooseBoundaryValue) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function localRect(rect: LooseBoundaryValue, viewportBounds: LooseBoundaryValue) {
  return {
    left: Math.round(rect.x - viewportBounds.x),
    top: Math.round(rect.y - viewportBounds.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function preferredPlacement(anchor: LooseBoundaryValue, displayBounds: LooseBoundaryValue) {
  const vertical = rectCenterY(anchor) < rectCenterY(displayBounds) ? 'bottom' : 'top';
  const horizontal = rectCenterX(anchor) < rectCenterX(displayBounds) ? 'start' : 'end';
  return `${vertical}-${horizontal}`;
}

function choosePlacement({ anchor, displayBounds, previousPlacement, traySize }: LooseBoundaryValue) {
  const preferred = preferredPlacement(anchor, displayBounds);
  const placements = ['top-start', 'top-end', 'bottom-start', 'bottom-end']
    .map((placement) => ({
      placement,
      score:
        overflowScore(trayBoundsForPlacement(anchor, traySize, placement), displayBounds) +
        (placement === preferred ? 0 : 32) +
        (placement === previousPlacement ? -PET_PLACEMENT_STICKINESS : 0),
    }))
    .sort((a, b) => a.score - b.score);
  return placements[0] ? placements[0].placement : preferred;
}

function contentViewportBounds({ contentBounds, displayBounds, viewportSize }: LooseBoundaryValue) {
  return {
    x: clampNumber(
      contentBounds.x + contentBounds.width - viewportSize.width,
      displayBounds.x,
      displayBounds.x + displayBounds.width - viewportSize.width,
    ),
    y: clampNumber(
      contentBounds.y + contentBounds.height - viewportSize.height,
      displayBounds.y,
      displayBounds.y + displayBounds.height - viewportSize.height,
    ),
    width: viewportSize.width,
    height: viewportSize.height,
  };
}

function computePetLayout({
  anchor,
  displayBounds,
  mascotSize,
  previousPlacement,
  traySize,
  viewportSize = PET_VIEWPORT_SIZE,
}: LooseBoundaryValue) {
  const viewport = {
    width: Math.min(viewportSize.width, displayBounds.width),
    height: Math.min(viewportSize.height, displayBounds.height),
  };
  const safeAnchor = clampRectToDisplay(
    {
      ...anchor,
      width: Math.min(mascotSize.width, displayBounds.width),
      height: Math.min(mascotSize.height, displayBounds.height),
    },
    displayBounds,
    { bottomPadding: PET_LAYOUT_PADDING.bottom },
  );
  const maxTrayWidth = Math.max(0, viewport.width - PET_LAYOUT_PADDING.left - PET_LAYOUT_PADDING.right);
  const maxTrayHeight = Math.max(0, viewport.height - safeAnchor.height - PET_LAYOUT_PADDING.bottom - PET_TRAY_GAP);
  const clampedTraySize =
    traySize == null
      ? null
      : {
          width: Math.min(traySize.width, maxTrayWidth),
          height: Math.min(traySize.height, maxTrayHeight),
        };
  const placement =
    clampedTraySize == null
      ? previousPlacement
      : choosePlacement({
          anchor: safeAnchor,
          displayBounds,
          previousPlacement,
          traySize: clampedTraySize,
        });
  const trayBounds =
    clampedTraySize == null
      ? null
      : clampRectToDisplay(trayBoundsForPlacement(safeAnchor, clampedTraySize, placement), displayBounds);
  const viewportBounds = contentViewportBounds({
    contentBounds: unionRects([expandedMascotBounds(safeAnchor), ...(trayBounds == null ? [] : [trayBounds])]),
    displayBounds,
    viewportSize: viewport,
  });
  return {
    anchor: safeAnchor,
    mascot: localRect(safeAnchor, viewportBounds),
    placement,
    tray: trayBounds == null ? null : localRect(trayBounds, viewportBounds),
    viewport,
    windowBounds: viewportBounds,
  };
}

function defaultPetAnchor(displayBounds: LooseBoundaryValue, mascotSize = PET_DEFAULT_MASCOT_SIZE) {
  return {
    x: displayBounds.x + displayBounds.width - mascotSize.width - PET_DEFAULT_MARGIN,
    y: displayBounds.y + displayBounds.height - mascotSize.height - PET_DEFAULT_MARGIN,
    width: mascotSize.width,
    height: mascotSize.height,
  };
}

export {
  PET_DEFAULT_MASCOT_SIZE,
  PET_DEFAULT_TRAY_SIZE,
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  computePetLayout,
  defaultPetAnchor,
  pointForRectCenter,
};
