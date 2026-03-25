import type { Vec2 } from "../types/mechanism";

export const GRID_SIZE = 32;
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 3.5;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function multiply(a: Vec2, scalar: number): Vec2 {
  return { x: a.x * scalar, y: a.y * scalar };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function rotate(v: Vec2, angleDeg: number): Vec2 {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: v.x * cos - v.y * sin,
    y: v.x * sin + v.y * cos,
  };
}

export function fromAngle(angleDeg: number): Vec2 {
  return rotate({ x: 1, y: 0 }, angleDeg);
}

export function projectPointOnLine(point: Vec2, origin: Vec2, direction: Vec2): Vec2 {
  const unit = normalize(direction);
  const projectionLength = dot(subtract(point, origin), unit);
  return add(origin, multiply(unit, projectionLength));
}

export function projectPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = subtract(end, start);
  const segmentLengthSq = dot(segment, segment);
  if (segmentLengthSq < 1e-9) {
    return { ...start };
  }

  const t = clamp(dot(subtract(point, start), segment) / segmentLengthSq, 0, 1);
  return add(start, multiply(segment, t));
}

export function snapPoint(point: Vec2, enabled: boolean, grid = GRID_SIZE): Vec2 {
  if (!enabled) {
    return point;
  }

  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  };
}

export function distancePointToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  return distance(point, projectPointOnSegment(point, start, end));
}
