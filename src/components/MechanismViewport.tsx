import { useEffect, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  GRID_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  clamp,
  distance,
  distancePointToSegment,
  snapPoint,
  vec,
} from "../lib/geometry";
import { createSliderGuidePreview, getBar, getNode, getVisibleBars } from "../lib/mechanism";
import type { DragInteraction, MechanismModel, Selection, Tool, Vec2, ViewState } from "../types/mechanism";

interface PointerHit {
  selection: Selection;
  world: Vec2;
}

interface PinchGesture {
  anchorWorld: Vec2;
  startDistance: number;
  startZoom: number;
}

interface ViewportProps {
  model: MechanismModel;
  selection: Selection;
  view: ViewState;
  activeTool: Tool;
  pendingBarStartId: string | null;
  pointerWorld: Vec2;
  onPointerWorldChange: (point: Vec2) => void;
  onSelect: (selection: Selection) => void;
  onViewChange: (view: ViewState) => void;
  onCreateNode: (point: Vec2, kind: "point" | "hinge", attachSelection: Selection) => void;
  onCreateBarStep: (selection: Selection, point: Vec2) => void;
  onAddSupport: (selection: Selection, point: Vec2, type: "fixed" | "slider") => void;
  onDeleteSelection: (selection: Selection) => void;
  onDragStart: (interaction: DragInteraction) => void;
  onDragMove: (pointerId: number, world: Vec2, screen: Vec2) => void;
  onDragEnd: (pointerId: number) => void;
}

const VIEWPORT_WIDTH = 2000;
const VIEWPORT_HEIGHT = 1400;
const BUTTON_ZOOM_FACTOR = 1.28;
const PINCH_ZOOM_EXPONENT = 1.18;
const WHEEL_ZOOM_SENSITIVITY = 0.0024;

function useGridLines(view: ViewState) {
  return useMemo(() => {
    const spacing = GRID_SIZE * view.zoom;
    if (spacing < 10 || !view.showGrid) {
      return [];
    }

    const originX = ((view.pan.x % spacing) + spacing) % spacing;
    const originY = ((view.pan.y % spacing) + spacing) % spacing;
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; major: boolean }> = [];

    for (let x = originX; x < VIEWPORT_WIDTH; x += spacing) {
      const index = Math.round((x - originX) / spacing);
      lines.push({ x1: x, y1: 0, x2: x, y2: VIEWPORT_HEIGHT, major: index % 5 === 0 });
    }
    for (let y = originY; y < VIEWPORT_HEIGHT; y += spacing) {
      const index = Math.round((y - originY) / spacing);
      lines.push({ x1: 0, y1: y, x2: VIEWPORT_WIDTH, y2: y, major: index % 5 === 0 });
    }

    return lines;
  }, [view]);
}

function screenToSvg(bounds: DOMRect, point: Vec2): Vec2 {
  const scale = Math.max(bounds.width / VIEWPORT_WIDTH, bounds.height / VIEWPORT_HEIGHT);
  const renderedWidth = VIEWPORT_WIDTH * scale;
  const renderedHeight = VIEWPORT_HEIGHT * scale;
  const offsetX = (bounds.width - renderedWidth) * 0.5;
  const offsetY = (bounds.height - renderedHeight) * 0.5;

  return {
    x: clamp((point.x - bounds.left - offsetX) / scale, 0, VIEWPORT_WIDTH),
    y: clamp((point.y - bounds.top - offsetY) / scale, 0, VIEWPORT_HEIGHT),
  };
}

function screenToWorld(bounds: DOMRect, point: Vec2, view: ViewState): Vec2 {
  const svgPoint = screenToSvg(bounds, point);
  return {
    x: (svgPoint.x - view.pan.x) / view.zoom,
    y: (svgPoint.y - view.pan.y) / view.zoom,
  };
}

function buildZoomedView(bounds: DOMRect, currentView: ViewState, screenPoint: Vec2, nextZoom: number): ViewState {
  const worldBefore = screenToWorld(bounds, screenPoint, currentView);
  const svgPoint = screenToSvg(bounds, screenPoint);
  return {
    ...currentView,
    zoom: nextZoom,
    pan: {
      x: svgPoint.x - worldBefore.x * nextZoom,
      y: svgPoint.y - worldBefore.y * nextZoom,
    },
  };
}

function getTouchPair(pointers: Map<number, Vec2>): [Vec2, Vec2] | null {
  const points = [...pointers.values()];
  if (points.length < 2) {
    return null;
  }

  return [points[0], points[1]];
}

function getTouchCenter(first: Vec2, second: Vec2): Vec2 {
  return {
    x: (first.x + second.x) * 0.5,
    y: (first.y + second.y) * 0.5,
  };
}

function createPinchGesture(bounds: DOMRect, first: Vec2, second: Vec2, view: ViewState): PinchGesture {
  return {
    anchorWorld: screenToWorld(bounds, getTouchCenter(first, second), view),
    startDistance: Math.max(distance(first, second), 1e-5),
    startZoom: view.zoom,
  };
}

function pickElement(model: MechanismModel, world: Vec2, zoom: number): PointerHit {
  const nodeThreshold = 14 / zoom;
  const barThreshold = 10 / zoom;

  for (const node of [...model.nodes].reverse()) {
    if (distance(node, world) <= nodeThreshold) {
      return { selection: { type: "node", id: node.id }, world };
    }
  }

  for (const support of [...model.supports].reverse()) {
    const node = getNode(model, support.nodeId);
    if (node && distance(node, world) <= nodeThreshold * 1.25) {
      return { selection: { type: "support", id: support.id }, world };
    }
  }

  for (const bar of [...getVisibleBars(model)].reverse()) {
    const nodeA = getNode(model, bar.nodeA);
    const nodeB = getNode(model, bar.nodeB);
    if (!nodeA || !nodeB) {
      continue;
    }
    if (distancePointToSegment(world, nodeA, nodeB) <= barThreshold) {
      return { selection: { type: "bar", id: bar.id }, world };
    }
  }

  return { selection: null, world };
}

export function MechanismViewport({
  model,
  selection,
  view,
  activeTool,
  pendingBarStartId,
  pointerWorld,
  onPointerWorldChange,
  onSelect,
  onViewChange,
  onCreateNode,
  onCreateBarStep,
  onAddSupport,
  onDeleteSelection,
  onDragStart,
  onDragMove,
  onDragEnd,
}: ViewportProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef(view);
  const touchPointersRef = useRef<Map<number, Vec2>>(new Map());
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const gridLines = useGridLines(view);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touchPointersRef.current.delete(event.pointerId);
        if (touchPointersRef.current.size < 2) {
          pinchGestureRef.current = null;
        }
      }
      onDragEnd(event.pointerId);
    };
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      touchPointersRef.current.clear();
      pinchGestureRef.current = null;
    };
  }, [onDragEnd]);

  const handleZoomButton = (factor: number) => {
    const nextZoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - view.zoom) <= 1e-5) {
      return;
    }

    if (!svgRef.current) {
      onViewChange({ ...view, zoom: nextZoom });
      return;
    }

    const bounds = svgRef.current.getBoundingClientRect();
    const center = vec(bounds.left + bounds.width * 0.5, bounds.top + bounds.height * 0.5);
    onViewChange(buildZoomedView(bounds, view, center, nextZoom));
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") {
      touchPointersRef.current.set(event.pointerId, vec(event.clientX, event.clientY));
      const touchPair = getTouchPair(touchPointersRef.current);
      if (touchPair && svgRef.current) {
        event.preventDefault();
        for (const pointerId of touchPointersRef.current.keys()) {
          onDragEnd(pointerId);
        }
        const bounds = svgRef.current.getBoundingClientRect();
        const [first, second] = touchPair;
        pinchGestureRef.current = createPinchGesture(bounds, first, second, viewRef.current);
        return;
      }
      pinchGestureRef.current = null;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const screen = vec(event.clientX, event.clientY);
    const rawWorld = screenToWorld(bounds, screen, view);
    const snappedWorld = snapPoint(rawWorld, view.snapToGrid);
    const hit = pickElement(model, rawWorld, view.zoom);
    onPointerWorldChange(activeTool === "select" ? rawWorld : snappedWorld);

    if (activeTool === "node") {
      onCreateNode(snappedWorld, "point", hit.selection);
      return;
    }

    if (activeTool === "hinge") {
      onCreateNode(rawWorld, "hinge", hit.selection);
      return;
    }

    if (activeTool === "bar") {
      onCreateBarStep(hit.selection, snappedWorld);
      return;
    }

    if (activeTool === "fixed" || activeTool === "slider") {
      onAddSupport(hit.selection, snappedWorld, activeTool);
      return;
    }

    if (activeTool === "delete") {
      onDeleteSelection(hit.selection);
      return;
    }

    onSelect(hit.selection);

    if (hit.selection?.type === "node") {
      const node = getNode(model, hit.selection.id);
      if (!node) {
        return;
      }

      onDragStart({
        kind: "node",
        id: node.id,
        pointerId: event.pointerId,
        startWorld: rawWorld,
        currentWorld: rawWorld,
        startNodes: { [node.id]: { x: node.x, y: node.y } },
      });
      return;
    }

    if (hit.selection?.type === "bar") {
      const bar = getBar(model, hit.selection.id);
      if (!bar) {
        return;
      }

      const nodeA = getNode(model, bar.nodeA);
      const nodeB = getNode(model, bar.nodeB);
      if (!nodeA || !nodeB) {
        return;
      }

      onDragStart({
        kind: "bar",
        id: bar.id,
        pointerId: event.pointerId,
        startWorld: rawWorld,
        currentWorld: rawWorld,
        startNodes: {
          [nodeA.id]: { x: nodeA.x, y: nodeA.y },
          [nodeB.id]: { x: nodeB.x, y: nodeB.y },
        },
      });
      return;
    }

    onDragStart({
      kind: "pan",
      id: "viewport",
      pointerId: event.pointerId,
      startWorld: rawWorld,
      currentWorld: rawWorld,
      startNodes: {},
      startPan: { ...view.pan },
      startScreen: screen,
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") {
      touchPointersRef.current.set(event.pointerId, vec(event.clientX, event.clientY));
      const touchPair = getTouchPair(touchPointersRef.current);

      if (touchPair && svgRef.current) {
        event.preventDefault();
        const [first, second] = touchPair;
        const currentDistance = Math.max(distance(first, second), 1e-5);
        const bounds = svgRef.current.getBoundingClientRect();
        const currentView = viewRef.current;
        const pinchGesture = pinchGestureRef.current ?? createPinchGesture(bounds, first, second, currentView);
        pinchGestureRef.current = pinchGesture;

        const zoomRatio = Math.pow(currentDistance / pinchGesture.startDistance, PINCH_ZOOM_EXPONENT);
        const nextZoom = clamp(pinchGesture.startZoom * zoomRatio, MIN_ZOOM, MAX_ZOOM);
        const center = getTouchCenter(first, second);
        const svgPoint = screenToSvg(bounds, center);
        const nextPan = {
          x: svgPoint.x - pinchGesture.anchorWorld.x * nextZoom,
          y: svgPoint.y - pinchGesture.anchorWorld.y * nextZoom,
        };

        if (
          Math.abs(nextZoom - currentView.zoom) > 1e-5 ||
          Math.abs(nextPan.x - currentView.pan.x) > 0.25 ||
          Math.abs(nextPan.y - currentView.pan.y) > 0.25
        ) {
          onViewChange({ ...currentView, zoom: nextZoom, pan: nextPan });
        }
        return;
      }
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const screen = vec(event.clientX, event.clientY);
    const rawWorld = screenToWorld(bounds, screen, view);
    const world = activeTool === "select" ? rawWorld : snapPoint(rawWorld, view.snapToGrid);
    onPointerWorldChange(world);
    onDragMove(event.pointerId, world, screen);
  };

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const nextZoom = clamp(view.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - view.zoom) <= 1e-5) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = vec(event.clientX, event.clientY);
    onViewChange(buildZoomedView(bounds, view, pointer, nextZoom));
  };

  return (
    <section className="viewport-shell">
      <div className="zoom-controls">
        <button type="button" onClick={() => handleZoomButton(BUTTON_ZOOM_FACTOR)} aria-label="Aumenta zoom">
          +
        </button>
        <button type="button" onClick={() => handleZoomButton(1 / BUTTON_ZOOM_FACTOR)} aria-label="Riduci zoom">
          -
        </button>
      </div>

      <svg
        ref={svgRef}
        className="viewport"
        viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onWheel={handleWheel}
      >
        <defs>
          <filter id="glow">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#5da4ff" floodOpacity="0.35" />
          </filter>
          <linearGradient id="cad-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0c1522" />
            <stop offset="100%" stopColor="#08111b" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={VIEWPORT_WIDTH} height={VIEWPORT_HEIGHT} className="viewport-bg" />

        {gridLines.map((line, index) => (
          <line
            key={`${line.x1}-${line.y1}-${index}`}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            className={line.major ? "grid-line major" : "grid-line"}
          />
        ))}

        <g transform={`translate(${view.pan.x} ${view.pan.y}) scale(${view.zoom})`}>
          <line x1="-2000" y1="0" x2="2000" y2="0" className="axis-line" />
          <line x1="0" y1="-2000" x2="0" y2="2000" className="axis-line" />

          {model.supports.map((support) => {
            const node = getNode(model, support.nodeId);
            if (!node) {
              return null;
            }

            const isSelected = selection?.type === "support" && selection.id === support.id;
            if (support.type === "fixed") {
              return (
                <g key={support.id} className={`support support-fixed ${isSelected ? "is-selected" : ""}`}>
                  <path d={`M ${node.x - 18} ${node.y + 18} L ${node.x + 18} ${node.y + 18} L ${node.x} ${node.y} Z`} />
                  <line x1={node.x - 22} y1={node.y + 22} x2={node.x + 22} y2={node.y + 22} />
                </g>
              );
            }

            const [guideA, guideB] = createSliderGuidePreview({ x: support.anchorX, y: support.anchorY }, support.angle);
            return (
              <g key={support.id} className={`support support-slider ${isSelected ? "is-selected" : ""}`}>
                <line x1={guideA.x} y1={guideA.y} x2={guideB.x} y2={guideB.y} />
                <rect x={node.x - 12} y={node.y - 9} width="24" height="18" rx="5" />
              </g>
            );
          })}

          {getVisibleBars(model).map((bar) => {
            const nodeA = getNode(model, bar.nodeA);
            const nodeB = getNode(model, bar.nodeB);
            if (!nodeA || !nodeB) {
              return null;
            }

            const isSelected = selection?.type === "bar" && selection.id === bar.id;
            return (
              <g key={bar.id} className={`bar ${isSelected ? "is-selected" : ""}`} filter={isSelected ? "url(#glow)" : undefined}>
                <line
                  x1={nodeA.x}
                  y1={nodeA.y}
                  x2={nodeB.x}
                  y2={nodeB.y}
                  stroke={bar.color}
                />
                <text x={(nodeA.x + nodeB.x) / 2} y={(nodeA.y + nodeB.y) / 2 - 10}>
                  {bar.label}
                </text>
              </g>
            );
          })}

          {model.nodes.map((node) => {
            const isSelected = selection?.type === "node" && selection.id === node.id;
            return (
              <g key={node.id} className={`node ${node.kind} ${isSelected ? "is-selected" : ""}`}>
                {node.kind === "hinge" ? (
                  <>
                    <circle cx={node.x} cy={node.y} r="11" />
                    <circle cx={node.x} cy={node.y} r="4" className="node-core" />
                  </>
                ) : (
                  <circle cx={node.x} cy={node.y} r="7" />
                )}
                <text x={node.x + 12} y={node.y - 12}>
                  {node.label}
                </text>
              </g>
            );
          })}

          {pendingBarStartId && (() => {
            const startNode = getNode(model, pendingBarStartId);
            if (!startNode) {
              return null;
            }
            return (
              <g className="bar-preview">
                <line x1={startNode.x} y1={startNode.y} x2={pointerWorld.x} y2={pointerWorld.y} />
              </g>
            );
          })()}
        </g>
      </svg>
    </section>
  );
}
