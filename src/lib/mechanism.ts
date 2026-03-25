import { createId } from "./ids";
import { GRID_SIZE, add, distance, distancePointToSegment, fromAngle, projectPointOnSegment, snapPoint, vec } from "./geometry";
import type {
  MechanismBar,
  MechanismModel,
  MechanismNode,
  MechanismSupport,
  NodeKind,
  Selection,
  SupportType,
  Vec2,
} from "../types/mechanism";

export function cloneModel(model: MechanismModel): MechanismModel {
  return {
    nodes: model.nodes.map((node) => ({ ...node })),
    bars: model.bars.map((bar) => ({ ...bar })),
    supports: model.supports.map((support) => ({ ...support })),
  };
}

export function createEmptyModel(): MechanismModel {
  return { nodes: [], bars: [], supports: [] };
}

export function getNode(model: MechanismModel, nodeId: string): MechanismNode | undefined {
  return model.nodes.find((node) => node.id === nodeId);
}

export function getBar(model: MechanismModel, barId: string): MechanismBar | undefined {
  return model.bars.find((bar) => bar.id === barId);
}

export function getSupport(model: MechanismModel, supportId: string): MechanismSupport | undefined {
  return model.supports.find((support) => support.id === supportId);
}

export function getSupportByNodeId(model: MechanismModel, nodeId: string): MechanismSupport | undefined {
  return model.supports.find((support) => support.nodeId === nodeId);
}

export function getVisibleBars(model: MechanismModel): MechanismBar[] {
  return model.bars.filter((bar) => !bar.auxiliary);
}

export function getRigidBodyNodeIds(model: MechanismModel, barId: string): string[] {
  const bar = getBar(model, barId);
  if (!bar) {
    return [];
  }

  const bodyId = bar.bodyId ?? bar.id;
  const nodeIds = new Set<string>();

  for (const item of model.bars) {
    const itemBodyId = item.bodyId ?? item.id;
    if (itemBodyId !== bodyId) {
      continue;
    }

    nodeIds.add(item.nodeA);
    nodeIds.add(item.nodeB);
  }

  return [...nodeIds];
}

export function findNearestVisibleBar(model: MechanismModel, point: Vec2, maxDistance = 12): MechanismBar | null {
  let nearest: MechanismBar | null = null;
  let bestDistance = maxDistance;

  for (const bar of getVisibleBars(model)) {
    const nodeA = getNode(model, bar.nodeA);
    const nodeB = getNode(model, bar.nodeB);
    if (!nodeA || !nodeB) {
      continue;
    }

    const candidateDistance = distancePointToSegment(point, nodeA, nodeB);
    if (candidateDistance <= bestDistance) {
      bestDistance = candidateDistance;
      nearest = bar;
    }
  }

  return nearest;
}

export function createNodeAt(position: Vec2, kind: NodeKind, snap = false): MechanismNode {
  const point = snapPoint(position, snap, GRID_SIZE);
  return {
    id: createId("node"),
    label: kind === "hinge" ? "Cerniera" : "Nodo",
    kind,
    x: point.x,
    y: point.y,
  };
}

export function addNode(model: MechanismModel, node: MechanismNode): MechanismModel {
  return {
    ...model,
    nodes: [...model.nodes, node],
  };
}

export function upsertNode(model: MechanismModel, nextNode: MechanismNode): MechanismModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => (node.id === nextNode.id ? nextNode : node)),
  };
}

export function addBarBetween(
  model: MechanismModel,
  nodeAId: string,
  nodeBId: string,
  options?: Partial<Pick<MechanismBar, "label" | "color" | "auxiliary" | "bodyId" | "length">>,
): MechanismModel {
  if (nodeAId === nodeBId) {
    return model;
  }

  const nodeA = getNode(model, nodeAId);
  const nodeB = getNode(model, nodeBId);
  if (!nodeA || !nodeB) {
    return model;
  }

  const exists = model.bars.some(
    (bar) =>
      (bar.nodeA === nodeAId && bar.nodeB === nodeBId) ||
      (bar.nodeA === nodeBId && bar.nodeB === nodeAId),
  );
  if (exists) {
    return model;
  }

  const id = createId("bar");
  const auxiliary = options?.auxiliary ?? false;
  const bar: MechanismBar = {
    id,
    label: options?.label ?? "Asta",
    nodeA: nodeAId,
    nodeB: nodeBId,
    length: options?.length ?? distance(nodeA, nodeB),
    color: options?.color ?? "#6aa0ff",
    auxiliary,
    bodyId: options?.bodyId ?? (auxiliary ? undefined : id),
  };

  return {
    ...model,
    bars: [...model.bars, bar],
  };
}

export function attachNodeToBar(
  model: MechanismModel,
  barId: string,
  rawPosition: Vec2,
  kind: NodeKind,
): { model: MechanismModel; node: MechanismNode | null } {
  const bar = getBar(model, barId);
  if (!bar) {
    return { model, node: null };
  }

  const nodeA = getNode(model, bar.nodeA);
  const nodeB = getNode(model, bar.nodeB);
  if (!nodeA || !nodeB) {
    return { model, node: null };
  }

  const position = projectPointOnSegment(rawPosition, nodeA, nodeB);
  const bodyId = bar.bodyId ?? bar.id;
  const currentLength = Math.max(distance(nodeA, nodeB), 1e-6);
  const tFromA = distance(nodeA, position) / currentLength;
  const ratio = Math.min(1, Math.max(0, tFromA));
  const node: MechanismNode = {
    id: createId("node"),
    label: kind === "hinge" ? "Giunto" : "Nodo",
    kind,
    x: position.x,
    y: position.y,
    embeddedBodyId: bodyId,
    embeddedT: ratio,
  };

  const rigidLengthToA = Math.max(1e-6, bar.length * ratio);
  const rigidLengthToB = Math.max(1e-6, bar.length * (1 - ratio));

  let nextModel = {
    ...model,
    nodes: [...model.nodes, node],
  };

  nextModel = addBarBetween(nextModel, node.id, bar.nodeA, {
    label: `${bar.label} rigid`,
    color: bar.color,
    auxiliary: true,
    bodyId,
    length: rigidLengthToA,
  });
  nextModel = addBarBetween(nextModel, node.id, bar.nodeB, {
    label: `${bar.label} rigid`,
    color: bar.color,
    auxiliary: true,
    bodyId,
    length: rigidLengthToB,
  });

  return { model: nextModel, node };
}

export function addSupportToNode(
  model: MechanismModel,
  nodeId: string,
  type: SupportType,
  angle = 0,
): MechanismModel {
  const node = getNode(model, nodeId);
  if (!node) {
    return model;
  }

  const existingIndex = model.supports.findIndex((support) => support.nodeId === nodeId);
  const support: MechanismSupport = {
    id: existingIndex >= 0 ? model.supports[existingIndex].id : createId("support"),
    label: type === "fixed" ? "Supporto fisso" : "Carrello",
    nodeId,
    type,
    angle,
    anchorX: node.x,
    anchorY: node.y,
  };

  if (existingIndex >= 0) {
    const supports = model.supports.map((item, index) => (index === existingIndex ? support : item));
    return { ...model, supports };
  }

  return {
    ...model,
    supports: [...model.supports, support],
  };
}

export function setNodeSupportType(
  model: MechanismModel,
  nodeId: string,
  type: SupportType | null,
): MechanismModel {
  const node = getNode(model, nodeId);
  if (!node) {
    return model;
  }

  const current = getSupportByNodeId(model, nodeId);
  if (!type) {
    return {
      ...model,
      supports: model.supports.filter((support) => support.nodeId !== nodeId),
    };
  }

  const support: MechanismSupport = {
    id: current?.id ?? createId("support"),
    label: type === "fixed" ? "Supporto fisso" : "Carrello",
    nodeId,
    type,
    anchorX: node.x,
    anchorY: node.y,
    angle: current?.type === "slider" ? current.angle : 0,
  };

  if (current) {
    return updateSupport(model, support);
  }

  return {
    ...model,
    supports: [...model.supports, support],
  };
}

export function updateSupport(model: MechanismModel, nextSupport: MechanismSupport): MechanismModel {
  return {
    ...model,
    supports: model.supports.map((support) => (support.id === nextSupport.id ? nextSupport : support)),
  };
}

export function updateBar(model: MechanismModel, nextBar: MechanismBar): MechanismModel {
  return {
    ...model,
    bars: model.bars.map((bar) => (bar.id === nextBar.id ? nextBar : bar)),
  };
}

export function removeSelection(model: MechanismModel, selection: Selection): MechanismModel {
  if (!selection) {
    return model;
  }

  if (selection.type === "node") {
    return {
      nodes: model.nodes.filter((node) => node.id !== selection.id),
      bars: model.bars.filter((bar) => bar.nodeA !== selection.id && bar.nodeB !== selection.id),
      supports: model.supports.filter((support) => support.nodeId !== selection.id),
    };
  }

  if (selection.type === "bar") {
    return {
      ...model,
      bars: model.bars.filter((bar) => bar.id !== selection.id),
    };
  }

  return {
    ...model,
    supports: model.supports.filter((support) => support.id !== selection.id),
  };
}

export function duplicateSelection(model: MechanismModel, selection: Selection): { model: MechanismModel; selection: Selection } {
  if (!selection) {
    return { model, selection: null };
  }

  const offset = vec(GRID_SIZE * 2, GRID_SIZE * 2);
  let nextModel = cloneModel(model);

  if (selection.type === "node") {
    const node = getNode(nextModel, selection.id);
    if (!node) {
      return { model, selection };
    }

    const copy: MechanismNode = {
      ...node,
      id: createId("node"),
      x: node.x + offset.x,
      y: node.y + offset.y,
      label: `${node.label} copia`,
    };
    nextModel = addNode(nextModel, copy);

    const support = nextModel.supports.find((item) => item.nodeId === node.id);
    if (support) {
      nextModel = {
        ...nextModel,
        supports: [
          ...nextModel.supports,
          {
            ...support,
            id: createId("support"),
            nodeId: copy.id,
            anchorX: support.anchorX + offset.x,
            anchorY: support.anchorY + offset.y,
          },
        ],
      };
    }

    return { model: nextModel, selection: { type: "node", id: copy.id } };
  }

  if (selection.type === "bar") {
    const bar = getBar(nextModel, selection.id);
    if (!bar) {
      return { model, selection };
    }

    const nodeA = getNode(nextModel, bar.nodeA);
    const nodeB = getNode(nextModel, bar.nodeB);
    if (!nodeA || !nodeB) {
      return { model, selection };
    }

    const copyA: MechanismNode = { ...nodeA, id: createId("node"), x: nodeA.x + offset.x, y: nodeA.y + offset.y };
    const copyB: MechanismNode = { ...nodeB, id: createId("node"), x: nodeB.x + offset.x, y: nodeB.y + offset.y };
    nextModel = addNode(addNode(nextModel, copyA), copyB);
    const barCopy: MechanismBar = {
      ...bar,
      id: createId("bar"),
      nodeA: copyA.id,
      nodeB: copyB.id,
      label: `${bar.label} copia`,
      bodyId: bar.auxiliary ? bar.bodyId : undefined,
    };
    if (!barCopy.auxiliary) {
      barCopy.bodyId = barCopy.id;
    }
    nextModel = { ...nextModel, bars: [...nextModel.bars, barCopy] };

    const supportCopies = nextModel.supports
      .filter((support) => support.nodeId === nodeA.id || support.nodeId === nodeB.id)
      .map((support) => ({
        ...support,
        id: createId("support"),
        nodeId: support.nodeId === nodeA.id ? copyA.id : copyB.id,
        anchorX: support.anchorX + offset.x,
        anchorY: support.anchorY + offset.y,
      }));
    nextModel = { ...nextModel, supports: [...nextModel.supports, ...supportCopies] };

    return { model: nextModel, selection: { type: "bar", id: barCopy.id } };
  }

  const support = getSupport(nextModel, selection.id);
  if (!support) {
    return { model, selection };
  }

  const node = getNode(nextModel, support.nodeId);
  if (!node) {
    return { model, selection };
  }

  const nodeCopy: MechanismNode = { ...node, id: createId("node"), x: node.x + offset.x, y: node.y + offset.y };
  const supportCopy: MechanismSupport = {
    ...support,
    id: createId("support"),
    nodeId: nodeCopy.id,
    anchorX: support.anchorX + offset.x,
    anchorY: support.anchorY + offset.y,
  };

  nextModel = addNode(nextModel, nodeCopy);
  nextModel = { ...nextModel, supports: [...nextModel.supports, supportCopy] };
  return { model: nextModel, selection: { type: "support", id: supportCopy.id } };
}

export function updateNodePosition(model: MechanismModel, nodeId: string, position: Vec2): MechanismModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => (node.id === nodeId ? { ...node, x: position.x, y: position.y } : node)),
    supports: model.supports.map((support) =>
      support.nodeId === nodeId && support.type === "fixed"
        ? { ...support, anchorX: position.x, anchorY: position.y }
        : support,
    ),
  };
}

export function translateNodes(model: MechanismModel, nodeIds: string[], delta: Vec2): MechanismModel {
  const idSet = new Set(nodeIds);
  return {
    ...model,
    nodes: model.nodes.map((node) =>
      idSet.has(node.id) ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node,
    ),
    supports: model.supports.map((support) => ({ ...support })),
  };
}

export function createSliderGuidePreview(origin: Vec2, angle: number, extent = 140): [Vec2, Vec2] {
  const direction = fromAngle(angle);
  return [
    add(origin, { x: direction.x * extent, y: direction.y * extent }),
    add(origin, { x: -direction.x * extent, y: -direction.y * extent }),
  ];
}



