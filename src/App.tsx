import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Inspector } from "./components/Inspector";
import { MechanismViewport } from "./components/MechanismViewport";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { vec } from "./lib/geometry";
import {
  addBarBetween,
  addNode,
  addSupportToNode,
  attachNodeToBar,
  cloneModel,
  createEmptyModel,
  createNodeAt,
  duplicateSelection,
  findNearestVisibleBar,
  getBar,
  getRigidBodyNodeIds,
  removeSelection,
  setNodeSupportType,
  translateNodes,
  updateBar,
  updateNodePosition,
  updateSupport,
  upsertNode,
} from "./lib/mechanism";
import {
  clampFiniteNumber,
  IMPORT_LIMITS,
  sanitizeColor,
  sanitizeLabel,
  validateImportedModel,
} from "./lib/security";
import { estimateDriveDirection, solveMechanism } from "./lib/solver";
import { createDemoMechanism } from "./data/demoMechanism";
import type {
  DragInteraction,
  MechanismBar,
  MechanismModel,
  MechanismNode,
  MechanismSupport,
  Selection,
  SupportType,
  Tool,
  Vec2,
  ViewState,
} from "./types/mechanism";

const DEFAULT_VIEW: ViewState = {
  pan: { x: 220, y: 120 },
  zoom: 1,
  showGrid: true,
  snapToGrid: true,
};
const DRAG_STEP_MAX_ERROR = 0.35;
const DRAG_STEP_AVG_ERROR = 0.08;
const MAX_HISTORY_SNAPSHOTS = 180;

function downloadJson(model: MechanismModel) {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "mechanism.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function serializeModel(model: MechanismModel): string {
  return JSON.stringify(model);
}

function appendSnapshotWithCap(history: MechanismModel[], snapshot: MechanismModel): MechanismModel[] {
  const next = [...history, cloneModel(snapshot)];
  if (next.length <= MAX_HISTORY_SNAPSHOTS) {
    return next;
  }
  return next.slice(next.length - MAX_HISTORY_SNAPSHOTS);
}

function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function rotatePointAround(point: Vec2, pivot: Vec2, angleRad: number): Vec2 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const translatedX = point.x - pivot.x;
  const translatedY = point.y - pivot.y;

  return {
    x: pivot.x + translatedX * cos - translatedY * sin,
    y: pivot.y + translatedX * sin + translatedY * cos,
  };
}

function getRigidBodyNodeIdsForNode(model: MechanismModel, nodeId: string): string[] {
  const node = model.nodes.find((item) => item.id === nodeId);
  const explicitBodyId = node?.embeddedBodyId;

  if (explicitBodyId) {
    const nodeIds = new Set<string>();
    for (const bar of model.bars) {
      if ((bar.bodyId ?? bar.id) !== explicitBodyId) {
        continue;
      }

      nodeIds.add(bar.nodeA);
      nodeIds.add(bar.nodeB);
    }

    return [...nodeIds];
  }

  const bodyIds = [...new Set(
    model.bars
      .filter((bar) => bar.nodeA === nodeId || bar.nodeB === nodeId)
      .map((bar) => bar.bodyId ?? bar.id),
  )];

  if (bodyIds.length !== 1) {
    return [];
  }

  const nodeIds = new Set<string>();
  for (const bar of model.bars) {
    if ((bar.bodyId ?? bar.id) !== bodyIds[0]) {
      continue;
    }

    nodeIds.add(bar.nodeA);
    nodeIds.add(bar.nodeB);
  }

  return [...nodeIds];
}

function buildRigidBodyRotationTargets(
  model: MechanismModel,
  rigidBodyNodeIds: string[],
  startWorld: Vec2,
  currentWorld: Vec2,
): Record<string, Vec2> | null {
  if (rigidBodyNodeIds.length === 0) {
    return null;
  }

  const rigidSet = new Set(rigidBodyNodeIds);
  const fixedSupports = model.supports.filter(
    (support) => support.type === "fixed" && rigidSet.has(support.nodeId),
  );

  if (fixedSupports.length !== 1) {
    return null;
  }

  const pivot = { x: fixedSupports[0].anchorX, y: fixedSupports[0].anchorY };
  const startRadius = Math.hypot(startWorld.x - pivot.x, startWorld.y - pivot.y);
  const currentRadius = Math.hypot(currentWorld.x - pivot.x, currentWorld.y - pivot.y);

  if (startRadius < 1e-6 || currentRadius < 1e-6) {
    return null;
  }

  const startAngle = Math.atan2(startWorld.y - pivot.y, startWorld.x - pivot.x);
  const currentAngle = Math.atan2(currentWorld.y - pivot.y, currentWorld.x - pivot.x);
  const angleDelta = currentAngle - startAngle;

  const locked: Record<string, Vec2> = {};
  for (const node of model.nodes) {
    if (!rigidSet.has(node.id)) {
      continue;
    }

    if (node.id === fixedSupports[0].nodeId) {
      locked[node.id] = { ...pivot };
      continue;
    }

    locked[node.id] = rotatePointAround(node, pivot, angleDelta);
  }

  return locked;
}

function projectPointOnCircle(point: Vec2, pivot: Vec2, radius: number): Vec2 {
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return { x: pivot.x + radius, y: pivot.y };
  }

  const scale = radius / length;
  return {
    x: pivot.x + dx * scale,
    y: pivot.y + dy * scale,
  };
}


function constrainNodeTargetToFixedBodies(model: MechanismModel, nodeId: string, rawTarget: Vec2): Vec2 {
  const connectedBodyIds = [...new Set(
    model.bars
      .filter((bar) => bar.nodeA === nodeId || bar.nodeB === nodeId)
      .map((bar) => bar.bodyId ?? bar.id),
  )];

  const node = model.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return rawTarget;
  }

  let constrained: Vec2 | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const bodyId of connectedBodyIds) {
    const nodeIds = new Set<string>();
    for (const bar of model.bars) {
      if ((bar.bodyId ?? bar.id) !== bodyId) {
        continue;
      }

      nodeIds.add(bar.nodeA);
      nodeIds.add(bar.nodeB);
    }

    const fixedSupports = model.supports.filter(
      (support) => support.type === "fixed" && nodeIds.has(support.nodeId),
    );

    if (fixedSupports.length !== 1) {
      continue;
    }

    const fixedSupport = fixedSupports[0];
    const pivot = { x: fixedSupport.anchorX, y: fixedSupport.anchorY };
    if (fixedSupport.nodeId === nodeId) {
      return pivot;
    }

    const radius = Math.hypot(node.x - pivot.x, node.y - pivot.y);
    if (radius < 1e-6) {
      continue;
    }

    const projected = projectPointOnCircle(rawTarget, pivot, radius);
    const error = Math.hypot(projected.x - rawTarget.x, projected.y - rawTarget.y);

    if (error < bestDistance) {
      bestDistance = error;
      constrained = projected;
    }
  }

  return constrained ?? rawTarget;
}
function buildSharedNodeRotationTargets(
  model: MechanismModel,
  nodeId: string,
  startWorld: Vec2,
  currentWorld: Vec2,
): Record<string, Vec2> | null {
  const connectedBodyIds = [...new Set(
    model.bars
      .filter((bar) => bar.nodeA === nodeId || bar.nodeB === nodeId)
      .map((bar) => bar.bodyId ?? bar.id),
  )];

  let bestTargets: Record<string, Vec2> | null = null;
  let bestError = Number.POSITIVE_INFINITY;

  for (const bodyId of connectedBodyIds) {
    const bodyNodeIds = new Set<string>();
    for (const bar of model.bars) {
      if ((bar.bodyId ?? bar.id) !== bodyId) {
        continue;
      }

      bodyNodeIds.add(bar.nodeA);
      bodyNodeIds.add(bar.nodeB);
    }

    if (!bodyNodeIds.has(nodeId)) {
      continue;
    }

    const fixedSupports = model.supports.filter(
      (support) => support.type === "fixed" && bodyNodeIds.has(support.nodeId),
    );

    if (fixedSupports.length !== 1 || fixedSupports[0].nodeId === nodeId) {
      continue;
    }

    const targets = buildRigidBodyRotationTargets(model, [...bodyNodeIds], startWorld, currentWorld);
    if (!targets || !targets[nodeId]) {
      continue;
    }

    const error = Math.hypot(targets[nodeId].x - currentWorld.x, targets[nodeId].y - currentWorld.y);
    if (error < bestError) {
      bestError = error;
      bestTargets = targets;
    }
  }

  return bestTargets;
}
function solveWithErrorGuard(
  candidateModel: MechanismModel,
  fallbackModel: MechanismModel,
  interaction?: {
    nodeId?: string;
    target?: Vec2;
    lockedNodePositions?: Record<string, Vec2>;
    targetStiffness?: number;
  },
) {
  const attempted = solveMechanism(candidateModel, interaction);
  if (attempted.maxError <= DRAG_STEP_MAX_ERROR && attempted.averageError <= DRAG_STEP_AVG_ERROR) {
    return attempted;
  }

  return solveMechanism(fallbackModel);
}
export default function App() {
  const initialModel = useMemo(() => createDemoMechanism(), []);
  const [model, setModel] = useState<MechanismModel>(() => cloneModel(initialModel));
  const [referenceModel, setReferenceModel] = useState<MechanismModel>(() => cloneModel(initialModel));
  const [undoStack, setUndoStack] = useState<MechanismModel[]>([]);
  const [redoStack, setRedoStack] = useState<MechanismModel[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [pointerWorld, setPointerWorld] = useState<Vec2>(vec(0, 0));
  const [pendingBarStartId, setPendingBarStartId] = useState<string | null>(null);
  const [solverError, setSolverError] = useState(0);
  const [solverMaxError, setSolverMaxError] = useState(0);
  const [hint, setHint] = useState("Trascina la demo, oppure seleziona un nodo e fissalo al terreno dal pannello proprieta.");
  const [dragInteraction, setDragInteraction] = useState<DragInteraction | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef(model);
  const referenceModelRef = useRef(referenceModel);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const dragRef = useRef<DragInteraction | null>(null);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    referenceModelRef.current = referenceModel;
  }, [referenceModel]);

  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);

  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);

  useEffect(() => {
    dragRef.current = dragInteraction;
  }, [dragInteraction]);

  const restoreSnapshot = (snapshot: MechanismModel) => {
    const next = cloneModel(snapshot);
    const solved = solveMechanism(next);
    setModel(solved.model);
    setReferenceModel(cloneModel(solved.model));
    setSolverError(solved.averageError);
    setSolverMaxError(solved.maxError);
    setSelection(null);
    setPendingBarStartId(null);
  };

  const pushUndoSnapshot = (snapshot: MechanismModel) => {
    setUndoStack((current) => appendSnapshotWithCap(current, snapshot));
    setRedoStack([]);
  };

  const commitModel = (nextModel: MechanismModel, options?: { pushHistory?: boolean }) => {
    const solved = solveMechanism(nextModel);
    const pushHistory = options?.pushHistory ?? true;

    if (pushHistory && serializeModel(referenceModelRef.current) !== serializeModel(solved.model)) {
      pushUndoSnapshot(referenceModelRef.current);
    }

    setModel(solved.model);
    setReferenceModel(cloneModel(solved.model));
    setSolverError(solved.averageError);
    setSolverMaxError(solved.maxError);
  };

  const handleUndo = () => {
    const history = undoStackRef.current;
    if (history.length === 0) {
      return;
    }

    const previous = history[history.length - 1];
    setUndoStack(history.slice(0, -1));
    setRedoStack((current) => appendSnapshotWithCap(current, referenceModelRef.current));
    setDragInteraction(null);
    restoreSnapshot(previous);
    setHint("Annullata ultima modifica.");
  };

  const handleRedo = () => {
    const history = redoStackRef.current;
    if (history.length === 0) {
      return;
    }

    const next = history[history.length - 1];
    setRedoStack(history.slice(0, -1));
    setUndoStack((current) => appendSnapshotWithCap(current, referenceModelRef.current));
    setDragInteraction(null);
    restoreSnapshot(next);
    setHint("Ripristinata modifica successiva.");
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && key === "z" && !event.shiftKey) {
        event.preventDefault();
        const history = undoStackRef.current;
        if (history.length === 0) {
          return;
        }

        const previous = history[history.length - 1];
        setUndoStack(history.slice(0, -1));
        setRedoStack((current) => appendSnapshotWithCap(current, referenceModelRef.current));
        setDragInteraction(null);
        restoreSnapshot(previous);
        setHint("Annullata ultima modifica.");
        return;
      }

      if (modifier && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        const history = redoStackRef.current;
        if (history.length === 0) {
          return;
        }

        const next = history[history.length - 1];
        setRedoStack(history.slice(0, -1));
        setUndoStack((current) => appendSnapshotWithCap(current, referenceModelRef.current));
        setDragInteraction(null);
        restoreSnapshot(next);
        setHint("Ripristinata modifica successiva.");
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        const nextModel = removeSelection(modelRef.current, selection);
        commitModel(nextModel);
        setSelection(null);
        setPendingBarStartId(null);
        setHint("Elemento eliminato.");
        return;
      }

      if (modifier && key === "d") {
        event.preventDefault();
        const duplicated = duplicateSelection(modelRef.current, selection);
        commitModel(duplicated.model);
        setSelection(duplicated.selection);
        setHint("Elemento duplicato con offset.");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selection]);

  useEffect(() => {
    if (!dragInteraction) {
      return;
    }

    let frame = 0;
    const tick = () => {
      const current = dragRef.current;
      if (!current) {
        return;
      }

      if (current.kind === "node") {
        const base = cloneModel(referenceModelRef.current);
        const rigidBodyNodeIds = getRigidBodyNodeIdsForNode(base, current.id);
        const delta = {
          x: current.currentWorld.x - current.startWorld.x,
          y: current.currentWorld.y - current.startWorld.y,
        };

        let next;
        if (rigidBodyNodeIds.length > 1) {
          const fixedSupportsInBody = base.supports.filter(
            (support) => support.type === "fixed" && rigidBodyNodeIds.includes(support.nodeId),
          );

          if (fixedSupportsInBody.some((support) => support.nodeId === current.id)) {
            next = solveMechanism(base);
          } else {
            const rotationTargets = buildRigidBodyRotationTargets(
              base,
              rigidBodyNodeIds,
              current.startWorld,
              current.currentWorld,
            );

            next = rotationTargets
              ? solveWithErrorGuard(base, base, { lockedNodePositions: rotationTargets })
              : solveWithErrorGuard(translateNodes(base, rigidBodyNodeIds, delta), base);
          }
        } else {
          const sharedBodyTargets = buildSharedNodeRotationTargets(
            base,
            current.id,
            current.startWorld,
            current.currentWorld,
          );

          if (sharedBodyTargets) {
            next = solveWithErrorGuard(base, base, { lockedNodePositions: sharedBodyTargets });
          } else {
            const constrainedTarget = constrainNodeTargetToFixedBodies(base, current.id, current.currentWorld);
            next = solveWithErrorGuard(base, base, {
              nodeId: current.id,
              target: constrainedTarget,
              targetStiffness: 0.16,
            });
          }
        }

        setModel(next.model);
        setSolverError(next.averageError);
        setSolverMaxError(next.maxError);
      }

      if (current.kind === "bar") {
        const delta = {
          x: current.currentWorld.x - current.startWorld.x,
          y: current.currentWorld.y - current.startWorld.y,
        };
        const base = cloneModel(referenceModelRef.current);
        const bar = getBar(base, current.id);
        if (bar) {
          const rigidBodyNodeIds = getRigidBodyNodeIds(base, current.id);
          const rotationTargets = buildRigidBodyRotationTargets(
            base,
            rigidBodyNodeIds,
            current.startWorld,
            current.currentWorld,
          );
          const next = rotationTargets
            ? solveWithErrorGuard(base, base, { lockedNodePositions: rotationTargets })
            : solveWithErrorGuard(translateNodes(base, rigidBodyNodeIds, delta), base);
          setModel(next.model);
          setSolverError(next.averageError);
          setSolverMaxError(next.maxError);
        }
      }

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [dragInteraction]);

  const handleNewProject = () => {
    const empty = createEmptyModel();
    commitModel(empty);
    setSelection(null);
    setPendingBarStartId(null);
    setHint("Progetto vuoto pronto. Inserisci nodi, aste e vincoli.");
  };

  const handleResetMechanism = () => {
    const reset = cloneModel(referenceModelRef.current);
    const solved = solveMechanism(reset);
    setModel(solved.model);
    setSolverError(solved.averageError);
    setSolverMaxError(solved.maxError);
    setHint("Posizioni ripristinate alla configurazione di riferimento.");
  };

  const handleCreateNode = (point: Vec2, kind: "point" | "hinge", attachSelection: Selection) => {
    if (kind === "hinge") {
      const fallbackBar = findNearestVisibleBar(modelRef.current, point, 18 / Math.max(view.zoom, 0.1));
      const targetBarId = attachSelection?.type === "bar" ? attachSelection.id : fallbackBar?.id;

      if (targetBarId) {
        const attached = attachNodeToBar(modelRef.current, targetBarId, point, kind);
        commitModel(attached.model);
        if (attached.node) {
          setSelection({ type: "node", id: attached.node.id });
          setHint("Cerniera incorporata al corpo rigido dell'asta senza spezzarla.");
        }
        return;
      }
    }

    const nextModel = addNode(modelRef.current, createNodeAt(point, kind, view.snapToGrid));
    commitModel(nextModel);
    setHint(kind === "hinge" ? "Cerniera aggiunta." : "Nodo aggiunto.");
  };

  const handleCreateBarStep = (hitSelection: Selection, point: Vec2) => {
    const existingNodeId = hitSelection?.type === "node" ? hitSelection.id : null;
    const workingModel = cloneModel(modelRef.current);
    let nodeId = existingNodeId;

    if (!nodeId) {
      const node = createNodeAt(point, "hinge", view.snapToGrid);
      node.label = "Giunto";
      nodeId = node.id;
      workingModel.nodes.push(node);
    }

    if (!pendingBarStartId) {
      setModel(workingModel);
      setReferenceModel(cloneModel(workingModel));
      setPendingBarStartId(nodeId);
      setSelection({ type: "node", id: nodeId });
      setHint("Seleziona il secondo nodo o una cerniera esistente per completare l'asta.");
      return;
    }

    const nextModel = addBarBetween(workingModel, pendingBarStartId, nodeId);
    const previousBarIds = new Set(workingModel.bars.map((bar) => bar.id));
    commitModel(nextModel);
    const createdBar = nextModel.bars.find((bar) => !previousBarIds.has(bar.id));
    setSelection(createdBar ? { type: "bar", id: createdBar.id } : null);
    setPendingBarStartId(null);
    setHint("Asta creata e collegata ai due nodi selezionati.");
  };

  const handleAddSupport = (hitSelection: Selection, point: Vec2, type: "fixed" | "slider") => {
    const workingModel = cloneModel(modelRef.current);
    let nodeId = hitSelection?.type === "node" ? hitSelection.id : null;

    if (!nodeId) {
      const node = createNodeAt(point, "hinge", view.snapToGrid);
      node.label = type === "fixed" ? "Nodo fissato" : "Nodo carrello";
      workingModel.nodes.push(node);
      nodeId = node.id;
    }

    const nextModel = addSupportToNode(workingModel, nodeId, type, 0);
    commitModel(nextModel);
    const support = nextModel.supports.find((item) => item.nodeId === nodeId);
    setSelection(support ? { type: "support", id: support.id } : null);
    setHint(type === "fixed" ? "Nodo vincolato al terreno." : "Carrello aggiunto. Modifica l'angolo guida nel pannello proprieta.");
  };

  const handleDeleteSelection = (nextSelection: Selection) => {
    const target = nextSelection ?? selection;
    const nextModel = removeSelection(modelRef.current, target);
    commitModel(nextModel);
    setSelection(null);
    setHint("Elemento eliminato.");
  };

  const handleDragStart = (interaction: DragInteraction) => {
    setDragInteraction(interaction);
  };

  const handleDragMove = (pointerId: number, world: Vec2, screen: Vec2) => {
    setPointerWorld(world);
    setDragInteraction((current) => {
      if (!current || current.pointerId !== pointerId) {
        return current;
      }

      if (current.kind === "pan" && current.startPan && current.startScreen) {
        const startPan = current.startPan;
        const startScreen = current.startScreen;
        setView((previous) => ({
          ...previous,
          pan: {
            x: startPan.x + (screen.x - startScreen.x),
            y: startPan.y + (screen.y - startScreen.y),
          },
        }));
      }

      return { ...current, currentWorld: world };
    });
  };

  const handleDragEnd = (pointerId: number) => {
    setDragInteraction((current) => {
      if (!current || current.pointerId !== pointerId) {
        return current;
      }

      if ((current.kind === "node" || current.kind === "bar") && serializeModel(referenceModelRef.current) !== serializeModel(modelRef.current)) {
        pushUndoSnapshot(referenceModelRef.current);
        setReferenceModel(cloneModel(modelRef.current));
        setHint("Spostamento applicato.");
      } else if (current.kind === "node" || current.kind === "bar") {
        setReferenceModel(cloneModel(modelRef.current));
      }

      return null;
    });
  };

  const handleDuplicate = () => {
    const duplicated = duplicateSelection(modelRef.current, selection);
    commitModel(duplicated.model);
    setSelection(duplicated.selection);
    setHint("Elemento duplicato con offset.");
  };

  const handleResetView = () => {
    setView(DEFAULT_VIEW);
  };

  const handleUpdateNode = (node: MechanismNode) => {
    const currentNode = modelRef.current.nodes.find((item) => item.id === node.id);
    if (!currentNode) {
      return;
    }

    const sanitizedNode: MechanismNode = {
      ...currentNode,
      ...node,
      label: sanitizeLabel(node.label, currentNode.label),
      kind: node.kind === "point" || node.kind === "hinge" ? node.kind : currentNode.kind,
      x: clampFiniteNumber(node.x, currentNode.x, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord),
      y: clampFiniteNumber(node.y, currentNode.y, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord),
    };

    if (sanitizedNode.embeddedT !== undefined) {
      sanitizedNode.embeddedT = clampFiniteNumber(sanitizedNode.embeddedT, currentNode.embeddedT ?? 0.5, 0, 1);
    }

    if (currentNode.embeddedBodyId) {
      const rigidBodyNodeIds = getRigidBodyNodeIdsForNode(modelRef.current, node.id);
      const delta = {
        x: sanitizedNode.x - currentNode.x,
        y: sanitizedNode.y - currentNode.y,
      };

      let nextModel = modelRef.current;
      if (rigidBodyNodeIds.length > 0 && (Math.abs(delta.x) > 1e-6 || Math.abs(delta.y) > 1e-6)) {
        nextModel = translateNodes(nextModel, rigidBodyNodeIds, delta);
      }

      nextModel = upsertNode(nextModel, sanitizedNode);
      commitModel(nextModel);
      return;
    }

    let nextModel = upsertNode(modelRef.current, sanitizedNode);
    nextModel = updateNodePosition(nextModel, sanitizedNode.id, sanitizedNode);
    commitModel(nextModel);
  };

  const handleUpdateBar = (bar: MechanismBar) => {
    const currentBar = modelRef.current.bars.find((item) => item.id === bar.id);
    if (!currentBar) {
      return;
    }

    const sanitizedBar: MechanismBar = {
      ...currentBar,
      ...bar,
      label: sanitizeLabel(bar.label, currentBar.label),
      color: sanitizeColor(bar.color, currentBar.color),
      length: clampFiniteNumber(bar.length, currentBar.length, IMPORT_LIMITS.minLength, IMPORT_LIMITS.maxLength),
      auxiliary: currentBar.auxiliary,
      bodyId: currentBar.bodyId,
    };

    commitModel(updateBar(modelRef.current, sanitizedBar));
  };

  const handleUpdateSupport = (support: MechanismSupport) => {
    const currentSupport = modelRef.current.supports.find((item) => item.id === support.id);
    if (!currentSupport) {
      return;
    }

    const supportType = support.type === "fixed" || support.type === "slider" ? support.type : currentSupport.type;
    const normalized: MechanismSupport = {
      ...currentSupport,
      ...support,
      type: supportType,
      label: supportType === "fixed" ? "Supporto fisso" : "Carrello",
      anchorX: clampFiniteNumber(support.anchorX, currentSupport.anchorX, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord),
      anchorY: clampFiniteNumber(support.anchorY, currentSupport.anchorY, IMPORT_LIMITS.minCoord, IMPORT_LIMITS.maxCoord),
      angle: clampFiniteNumber(support.angle, currentSupport.angle, IMPORT_LIMITS.minAngle, IMPORT_LIMITS.maxAngle),
    };

    commitModel(updateSupport(modelRef.current, normalized));
  };

  const handleChangeNodeSupport = (nodeId: string, type: SupportType | null) => {
    commitModel(setNodeSupportType(modelRef.current, nodeId, type));
    if (type === "fixed") {
      setHint("Nodo bloccato al terreno.");
      return;
    }
    if (type === "slider") {
      setHint("Nodo trasformato in carrello su guida.");
      return;
    }
    setHint("Nodo reso libero dal terreno.");
  };

  const handleSave = () => {
    downloadJson(modelRef.current);
    setHint("Configurazione esportata in JSON.");
  };

  const handleLoadClick = () => fileInputRef.current?.click();

  const handleLoadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > IMPORT_LIMITS.maxFileBytes) {
      setHint(`File troppo grande (${Math.round(file.size / 1024)} KB). Limite: ${Math.round(IMPORT_LIMITS.maxFileBytes / 1024)} KB.`);
      event.target.value = "";
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const validated = validateImportedModel(parsed);
      if (!validated) {
        setHint("JSON non valido o troppo grande. Controlla struttura e dimensioni del file.");
        return;
      }

      commitModel(validated.model);
      setSelection(null);
      setPendingBarStartId(null);

      if (validated.warnings.length > 0) {
        setHint(`Configurazione caricata da ${file.name} con ${validated.warnings.length} correzioni di sicurezza.`);
      } else {
        setHint(`Configurazione caricata da ${file.name}.`);
      }
    } catch {
      setHint("JSON non valido. Controlla il file e riprova.");
    } finally {
      event.target.value = "";
    }
  };

  const motionHint = selection?.type === "node"
    ? (() => {
        const drive = estimateDriveDirection(model, selection.id);
        if (!drive) {
          return "Nodo libero: trascinabile in ogni direzione.";
        }
        return `Direzione dominante ${drive.x.toFixed(2)}, ${drive.y.toFixed(2)}.`;
      })()
    : "Trascina nodi o aste per muovere il sistema. Le cerniere aggiunte sopra un'asta restano agganciate al corpo rigido.";

  return (
    <div className="app-shell">
      <TopBar
        snapToGrid={view.snapToGrid}
        showGrid={view.showGrid}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onToggleSnap={() => setView((current) => ({ ...current, snapToGrid: !current.snapToGrid }))}
        onToggleGrid={() => setView((current) => ({ ...current, showGrid: !current.showGrid }))}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onNewProject={handleNewProject}
        onSave={handleSave}
        onLoad={handleLoadClick}
        onResetMechanism={handleResetMechanism}
      />

      <main className="workspace">
        <Toolbar
          activeTool={activeTool}
          onToolChange={(tool) => {
            setActiveTool(tool);
            setPendingBarStartId(null);
          }}
          onDuplicate={handleDuplicate}
          onDelete={() => handleDeleteSelection(selection)}
          onResetView={handleResetView}
        />

        <div className="viewport-column">
          <MechanismViewport
            model={model}
            selection={selection}
            view={view}
            activeTool={activeTool}
            pendingBarStartId={pendingBarStartId}
            pointerWorld={pointerWorld}
            onPointerWorldChange={setPointerWorld}
            onSelect={setSelection}
            onViewChange={setView}
            onCreateNode={handleCreateNode}
            onCreateBarStep={handleCreateBarStep}
            onAddSupport={handleAddSupport}
            onDeleteSelection={handleDeleteSelection}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
          />

          <section className="status-panel">
            <div>
              <strong>Coordinate</strong> {pointerWorld.x.toFixed(1)}, {pointerWorld.y.toFixed(1)}
            </div>
            <div>
              <strong>Vista</strong> zoom {(view.zoom * 100).toFixed(0)}%
            </div>
            <div>
              <strong>Solver</strong> media {solverError.toFixed(4)} / max {solverMaxError.toFixed(4)}
            </div>
            <div>
              <strong>Hint</strong> {hint}
            </div>
            <div>
              <strong>Movimento</strong> {motionHint}
            </div>
          </section>
        </div>

        <Inspector
          model={model}
          selection={selection}
          solverError={solverError}
          onUpdateNode={handleUpdateNode}
          onUpdateBar={handleUpdateBar}
          onUpdateSupport={handleUpdateSupport}
          onChangeNodeSupport={handleChangeNodeSupport}
        />
      </main>

      <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={handleLoadFile} />
    </div>
  );
}















































