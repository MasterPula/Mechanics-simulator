import { clamp, distance, fromAngle, multiply, normalize, projectPointOnLine, subtract, vec } from "./geometry";
import { cloneModel } from "./mechanism";
import type { MechanismModel, SolverResult, Vec2 } from "../types/mechanism";

interface SolverInteraction {
  nodeId?: string;
  target?: Vec2;
  lockedNodePositions?: Record<string, Vec2>;
  targetStiffness?: number;
}

function collectFixedNodes(model: MechanismModel): Set<string> {
  return new Set(model.supports.filter((support) => support.type === "fixed").map((support) => support.nodeId));
}

function projectTargetToSupports(model: MechanismModel, nodeId: string, target: Vec2): Vec2 {
  const support = model.supports.find((item) => item.nodeId === nodeId);
  if (!support) {
    return target;
  }

  if (support.type === "fixed") {
    return vec(support.anchorX, support.anchorY);
  }

  return projectPointOnLine(
    target,
    vec(support.anchorX, support.anchorY),
    fromAngle(support.angle),
  );
}

function stabilizeEmbeddedNodes(model: MechanismModel, immovableNodeIds: Set<string>): void {
  const nodeMap = new Map(model.nodes.map((node) => [node.id, node]));

  for (const node of model.nodes) {
    if (!node.embeddedBodyId) {
      continue;
    }

    const bodyBars = model.bars.filter((bar) => (bar.bodyId ?? bar.id) === node.embeddedBodyId);
    const visibleBar = bodyBars.find((bar) => !bar.auxiliary);
    if (!visibleBar) {
      continue;
    }

    const nodeA = nodeMap.get(visibleBar.nodeA);
    const nodeB = nodeMap.get(visibleBar.nodeB);
    if (!nodeA || !nodeB) {
      continue;
    }

    const dx = nodeB.x - nodeA.x;
    const dy = nodeB.y - nodeA.y;
    const denom = dx * dx + dy * dy;
    const projectionRatio = denom < 1e-6
      ? 0.5
      : clamp(((node.x - nodeA.x) * dx + (node.y - nodeA.y) * dy) / denom, 0, 1);

    const ratio = clamp(node.embeddedT ?? projectionRatio, 0, 1);
    const rigidLengthToA = Math.max(1e-6, visibleBar.length * ratio);
    const rigidLengthToB = Math.max(1e-6, visibleBar.length * (1 - ratio));

    for (const bar of bodyBars) {
      if (!bar.auxiliary) {
        continue;
      }

      const linksToA =
        (bar.nodeA === node.id && bar.nodeB === visibleBar.nodeA) ||
        (bar.nodeB === node.id && bar.nodeA === visibleBar.nodeA);
      if (linksToA) {
        bar.length = rigidLengthToA;
      }

      const linksToB =
        (bar.nodeA === node.id && bar.nodeB === visibleBar.nodeB) ||
        (bar.nodeB === node.id && bar.nodeA === visibleBar.nodeB);
      if (linksToB) {
        bar.length = rigidLengthToB;
      }
    }

    const support = model.supports.find((item) => item.nodeId === node.id);
    if (support?.type === "fixed") {
      const pivot = { x: support.anchorX, y: support.anchorY };
      node.x = pivot.x;
      node.y = pivot.y;

      let axis = normalize({ x: nodeB.x - nodeA.x, y: nodeB.y - nodeA.y });
      if (Math.hypot(nodeB.x - nodeA.x, nodeB.y - nodeA.y) < 1e-6) {
        axis = normalize({ x: nodeB.x - pivot.x, y: nodeB.y - pivot.y });
      }

      const targetA = {
        x: pivot.x - axis.x * rigidLengthToA,
        y: pivot.y - axis.y * rigidLengthToA,
      };
      const targetB = {
        x: pivot.x + axis.x * rigidLengthToB,
        y: pivot.y + axis.y * rigidLengthToB,
      };

      if (!immovableNodeIds.has(nodeA.id)) {
        nodeA.x = targetA.x;
        nodeA.y = targetA.y;
      }

      if (!immovableNodeIds.has(nodeB.id)) {
        nodeB.x = targetB.x;
        nodeB.y = targetB.y;
      }

      continue;
    }

    if (support?.type === "slider") {
      const projected = projectPointOnLine(
        node,
        vec(support.anchorX, support.anchorY),
        fromAngle(support.angle),
      );

      if (!immovableNodeIds.has(node.id)) {
        node.x = projected.x;
        node.y = projected.y;
      }

      const pivot = { x: node.x, y: node.y };
      let axis = normalize({ x: nodeB.x - nodeA.x, y: nodeB.y - nodeA.y });
      if (Math.hypot(nodeB.x - nodeA.x, nodeB.y - nodeA.y) < 1e-6) {
        axis = normalize({ x: nodeB.x - pivot.x, y: nodeB.y - pivot.y });
      }

      const targetA = {
        x: pivot.x - axis.x * rigidLengthToA,
        y: pivot.y - axis.y * rigidLengthToA,
      };
      const targetB = {
        x: pivot.x + axis.x * rigidLengthToB,
        y: pivot.y + axis.y * rigidLengthToB,
      };

      if (!immovableNodeIds.has(nodeA.id)) {
        nodeA.x = targetA.x;
        nodeA.y = targetA.y;
      }

      if (!immovableNodeIds.has(nodeB.id)) {
        nodeB.x = targetB.x;
        nodeB.y = targetB.y;
      }

      continue;
    }

    if (!support && !immovableNodeIds.has(node.id)) {
      node.x = nodeA.x + (nodeB.x - nodeA.x) * ratio;
      node.y = nodeA.y + (nodeB.y - nodeA.y) * ratio;
    }
  }
}

function computeBarError(model: MechanismModel): { average: number; max: number } {
  if (model.bars.length === 0) {
    return { average: 0, max: 0 };
  }

  const nodeMap = new Map(model.nodes.map((node) => [node.id, node]));
  let sum = 0;
  let max = 0;

  for (const bar of model.bars) {
    const a = nodeMap.get(bar.nodeA);
    const b = nodeMap.get(bar.nodeB);
    if (!a || !b) {
      continue;
    }

    const error = Math.abs(distance(a, b) - bar.length);
    sum += error;
    max = Math.max(max, error);
  }

  return { average: sum / model.bars.length, max };
}

export function solveMechanism(
  model: MechanismModel,
  interaction?: SolverInteraction,
  iterations = 200,
): SolverResult {
  const next = cloneModel(model);
  const nodeMap = new Map(next.nodes.map((node) => [node.id, node]));
  const fixedNodes = collectFixedNodes(next);
  const lockedPositions = new Map<string, Vec2>();

  if (interaction?.lockedNodePositions) {
    for (const [nodeId, position] of Object.entries(interaction.lockedNodePositions)) {
      lockedPositions.set(nodeId, projectTargetToSupports(next, nodeId, position));
    }
  }

  let drivenNodeId: string | null = null;
  let drivenTarget: Vec2 | null = null;
  const targetStiffness = clamp(interaction?.targetStiffness ?? 0.14, 0.03, 1);

  if (interaction?.nodeId && interaction.target) {
    const projectedTarget = projectTargetToSupports(next, interaction.nodeId, interaction.target);
    if (fixedNodes.has(interaction.nodeId)) {
      lockedPositions.set(interaction.nodeId, projectedTarget);
    } else {
      drivenNodeId = interaction.nodeId;
      drivenTarget = projectedTarget;
    }
  }

  const immovableNodeIds = new Set<string>([...fixedNodes, ...lockedPositions.keys()]);
  stabilizeEmbeddedNodes(next, immovableNodeIds);

  for (let i = 0; i < iterations; i += 1) {
    if (drivenNodeId && drivenTarget) {
      const drivenNode = nodeMap.get(drivenNodeId);
      if (drivenNode && !immovableNodeIds.has(drivenNodeId)) {
        drivenNode.x += (drivenTarget.x - drivenNode.x) * targetStiffness;
        drivenNode.y += (drivenTarget.y - drivenNode.y) * targetStiffness;
      }
    }

    for (const [nodeId, position] of lockedPositions) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        continue;
      }

      node.x = position.x;
      node.y = position.y;
    }

    for (const support of next.supports) {
      const node = nodeMap.get(support.nodeId);
      if (!node) {
        continue;
      }

      if (support.type === "fixed") {
        node.x = support.anchorX;
        node.y = support.anchorY;
        continue;
      }

      const projected = projectPointOnLine(
        node,
        vec(support.anchorX, support.anchorY),
        fromAngle(support.angle),
      );
      node.x = projected.x;
      node.y = projected.y;
    }

    stabilizeEmbeddedNodes(next, immovableNodeIds);

    for (const bar of next.bars) {
      const nodeA = nodeMap.get(bar.nodeA);
      const nodeB = nodeMap.get(bar.nodeB);
      if (!nodeA || !nodeB) {
        continue;
      }

      const delta = subtract(nodeB, nodeA);
      const currentLength = Math.hypot(delta.x, delta.y);
      if (currentLength < 1e-6) {
        const fallback = multiply(normalize(fromAngle(0)), bar.length * 0.5);
        if (!immovableNodeIds.has(nodeA.id)) {
          nodeA.x -= fallback.x;
          nodeA.y -= fallback.y;
        }
        if (!immovableNodeIds.has(nodeB.id)) {
          nodeB.x += fallback.x;
          nodeB.y += fallback.y;
        }
        continue;
      }

      const difference = (currentLength - bar.length) / currentLength;
      const correction = multiply(delta, difference);

      const aLocked = immovableNodeIds.has(nodeA.id);
      const bLocked = immovableNodeIds.has(nodeB.id);

      if (aLocked && bLocked) {
        continue;
      }

      if (aLocked) {
        nodeB.x -= correction.x;
        nodeB.y -= correction.y;
        continue;
      }

      if (bLocked) {
        nodeA.x += correction.x;
        nodeA.y += correction.y;
        continue;
      }

      nodeA.x += correction.x * 0.5;
      nodeA.y += correction.y * 0.5;
      nodeB.x -= correction.x * 0.5;
      nodeB.y -= correction.y * 0.5;
    }

    stabilizeEmbeddedNodes(next, immovableNodeIds);
  }

  const error = computeBarError(next);
  return { model: next, averageError: error.average, maxError: error.max };
}

export function estimateDriveDirection(model: MechanismModel, nodeId: string): Vec2 | null {
  const bars = model.bars.filter((bar) => bar.nodeA === nodeId || bar.nodeB === nodeId);
  if (bars.length === 0) {
    return null;
  }

  const nodeMap = new Map(model.nodes.map((node) => [node.id, node]));
  let accumulated = vec(0, 0);

  for (const bar of bars) {
    const other = nodeMap.get(bar.nodeA === nodeId ? bar.nodeB : bar.nodeA);
    const current = nodeMap.get(nodeId);
    if (!other || !current) {
      continue;
    }

    accumulated.x += normalize(subtract(other, current)).x;
    accumulated.y += normalize(subtract(other, current)).y;
  }

  const length = Math.hypot(accumulated.x, accumulated.y);
  if (length < 1e-6) {
    return null;
  }

  return { x: accumulated.x / length, y: accumulated.y / length };
}

