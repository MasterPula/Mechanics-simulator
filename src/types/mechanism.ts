export type Tool = "select" | "node" | "hinge" | "bar" | "slider" | "fixed" | "delete";

export type NodeKind = "point" | "hinge";
export type SupportType = "fixed" | "slider";

export interface Vec2 {
  x: number;
  y: number;
}

export interface MechanismNode extends Vec2 {
  id: string;
  label: string;
  kind: NodeKind;
  embeddedBodyId?: string;
  embeddedT?: number;
}

export interface MechanismBar {
  id: string;
  label: string;
  nodeA: string;
  nodeB: string;
  length: number;
  color: string;
  auxiliary?: boolean;
  bodyId?: string;
}

export interface MechanismSupport {
  id: string;
  label: string;
  nodeId: string;
  type: SupportType;
  anchorX: number;
  anchorY: number;
  angle: number;
}

export interface MechanismModel {
  nodes: MechanismNode[];
  bars: MechanismBar[];
  supports: MechanismSupport[];
}

export type Selection =
  | { type: "node"; id: string }
  | { type: "bar"; id: string }
  | { type: "support"; id: string }
  | null;

export interface ViewState {
  pan: Vec2;
  zoom: number;
  showGrid: boolean;
  snapToGrid: boolean;
}

export interface DragInteraction {
  kind: "node" | "bar" | "pan";
  id: string;
  pointerId: number;
  startWorld: Vec2;
  currentWorld: Vec2;
  startNodes: Record<string, Vec2>;
  startPan?: Vec2;
  startScreen?: Vec2;
}

export interface SolverResult {
  model: MechanismModel;
  averageError: number;
  maxError: number;
}


