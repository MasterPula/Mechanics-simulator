import type { MechanismBar, MechanismModel, MechanismNode, MechanismSupport } from "../types/mechanism";

export const IMPORT_LIMITS = {
  maxFileBytes: 1_000_000,
  maxNodes: 800,
  maxBars: 1600,
  maxSupports: 800,
  maxLabelLength: 80,
  minCoord: -1_000_000,
  maxCoord: 1_000_000,
  minLength: 1,
  maxLength: 1_000_000,
  minAngle: -3600,
  maxAngle: 3600,
};

const COLOR_PATTERN =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^rgba?\(\s*(\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function clampFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

export function sanitizeLabel(value: unknown, fallback: string, maxLength = IMPORT_LIMITS.maxLabelLength): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : fallback;
}

export function sanitizeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const color = value.trim();
  return COLOR_PATTERN.test(color) ? color : fallback;
}

function normalizeNodeKind(value: unknown): MechanismNode["kind"] {
  return value === "point" || value === "hinge" ? value : "hinge";
}

function normalizeSupportType(value: unknown): MechanismSupport["type"] {
  return value === "fixed" || value === "slider" ? value : "fixed";
}

function buildId(rawId: unknown, fallbackPrefix: string, index: number, seen: Set<string>): string {
  const candidate = typeof rawId === "string" ? rawId.trim() : "";
  if (candidate.length > 0 && !seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }

  let attempt = `${fallbackPrefix}-${index.toString(36)}`;
  let suffix = 0;
  while (seen.has(attempt)) {
    suffix += 1;
    attempt = `${fallbackPrefix}-${index.toString(36)}-${suffix.toString(36)}`;
  }
  seen.add(attempt);
  return attempt;
}

export function validateImportedModel(input: unknown): { model: MechanismModel; warnings: string[] } | null {
  if (!isRecord(input)) {
    return null;
  }

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawBars = Array.isArray(input.bars) ? input.bars : [];
  const rawSupports = Array.isArray(input.supports) ? input.supports : [];

  if (
    rawNodes.length > IMPORT_LIMITS.maxNodes ||
    rawBars.length > IMPORT_LIMITS.maxBars ||
    rawSupports.length > IMPORT_LIMITS.maxSupports
  ) {
    return null;
  }

  const warnings: string[] = [];
  const nodeIds = new Set<string>();
  const barIds = new Set<string>();
  const supportIds = new Set<string>();
  const nodes: MechanismNode[] = [];
  const bars: MechanismBar[] = [];

  for (let i = 0; i < rawNodes.length; i += 1) {
    const rawNode = rawNodes[i];
    if (!isRecord(rawNode)) {
      warnings.push(`Nodo ${i + 1} ignorato (formato non valido).`);
      continue;
    }

    const id = buildId(rawNode.id, "node", i + 1, nodeIds);
    const label = sanitizeLabel(rawNode.label, "Giunto");
    const kind = normalizeNodeKind(rawNode.kind);
    const x = clampFiniteNumber(rawNode.x, 0, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord);
    const y = clampFiniteNumber(rawNode.y, 0, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord);

    const node: MechanismNode = { id, label, kind, x, y };
    if (typeof rawNode.embeddedBodyId === "string" && rawNode.embeddedBodyId.trim().length > 0) {
      node.embeddedBodyId = rawNode.embeddedBodyId.trim();
    }
    if (typeof rawNode.embeddedT === "number" && Number.isFinite(rawNode.embeddedT)) {
      node.embeddedT = clampFiniteNumber(rawNode.embeddedT, 0.5, 0, 1);
    }

    nodes.push(node);
  }

  const validNodeIdSet = new Set(nodes.map((node) => node.id));

  for (let i = 0; i < rawBars.length; i += 1) {
    const rawBar = rawBars[i];
    if (!isRecord(rawBar)) {
      warnings.push(`Asta ${i + 1} ignorata (formato non valido).`);
      continue;
    }

    const nodeA = typeof rawBar.nodeA === "string" ? rawBar.nodeA : "";
    const nodeB = typeof rawBar.nodeB === "string" ? rawBar.nodeB : "";
    if (!validNodeIdSet.has(nodeA) || !validNodeIdSet.has(nodeB) || nodeA === nodeB) {
      warnings.push(`Asta ${i + 1} ignorata (nodi non validi).`);
      continue;
    }

    const id = buildId(rawBar.id, "bar", i + 1, barIds);
    const label = sanitizeLabel(rawBar.label, "Asta");
    const color = sanitizeColor(rawBar.color, "#6aa0ff");
    const length = clampFiniteNumber(rawBar.length, 10, IMPORT_LIMITS.minLength, IMPORT_LIMITS.maxLength);
    const auxiliary = rawBar.auxiliary === true;
    const bodyId =
      typeof rawBar.bodyId === "string" && rawBar.bodyId.trim().length > 0
        ? rawBar.bodyId.trim()
        : auxiliary
          ? undefined
          : id;

    bars.push({
      id,
      label,
      nodeA,
      nodeB,
      length,
      color,
      auxiliary,
      bodyId,
    });
  }

  const supportsByNode = new Map<string, MechanismSupport>();
  for (let i = 0; i < rawSupports.length; i += 1) {
    const rawSupport = rawSupports[i];
    if (!isRecord(rawSupport)) {
      warnings.push(`Vincolo ${i + 1} ignorato (formato non valido).`);
      continue;
    }

    const nodeId = typeof rawSupport.nodeId === "string" ? rawSupport.nodeId : "";
    if (!validNodeIdSet.has(nodeId)) {
      warnings.push(`Vincolo ${i + 1} ignorato (nodo inesistente).`);
      continue;
    }

    const id = buildId(rawSupport.id, "support", i + 1, supportIds);
    const type = normalizeSupportType(rawSupport.type);
    const label = sanitizeLabel(rawSupport.label, type === "fixed" ? "Supporto fisso" : "Carrello");
    const anchorX = clampFiniteNumber(rawSupport.anchorX, 0, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord);
    const anchorY = clampFiniteNumber(rawSupport.anchorY, 0, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord);
    const angle = clampFiniteNumber(rawSupport.angle, 0, IMPORT_LIMITS.minAngle, IMPORT_LIMITS.maxAngle);

    supportsByNode.set(nodeId, {
      id,
      label,
      nodeId,
      type,
      anchorX,
      anchorY,
      angle,
    });
  }

  const supports = [...supportsByNode.values()];
  return {
    model: {
      nodes,
      bars,
      supports,
    },
    warnings,
  };
}
