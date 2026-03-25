import { distance } from "../lib/geometry";
import { getBar, getNode, getSupport, getSupportByNodeId, getVisibleBars } from "../lib/mechanism";
import type { MechanismBar, MechanismModel, MechanismNode, MechanismSupport, Selection, SupportType } from "../types/mechanism";

interface InspectorProps {
  model: MechanismModel;
  selection: Selection;
  solverError: number;
  onUpdateNode: (node: MechanismNode) => void;
  onUpdateBar: (bar: MechanismBar) => void;
  onUpdateSupport: (support: MechanismSupport) => void;
  onChangeNodeSupport: (nodeId: string, type: SupportType | null) => void;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function Inspector({
  model,
  selection,
  solverError,
  onUpdateNode,
  onUpdateBar,
  onUpdateSupport,
  onChangeNodeSupport,
}: InspectorProps) {
  const visibleBars = getVisibleBars(model);
  const node = selection?.type === "node" ? getNode(model, selection.id) : undefined;
  const nodeSupport = node ? getSupportByNodeId(model, node.id) : undefined;
  const bar = selection?.type === "bar" ? getBar(model, selection.id) : undefined;
  const support = selection?.type === "support" ? getSupport(model, selection.id) : undefined;

  return (
    <aside className="inspector-panel">
      <div className="panel-title">Proprieta</div>
      <div className="inspector-summary">
        <span>Nodi {model.nodes.length}</span>
        <span>Aste {visibleBars.length}</span>
        <span>Vincoli {model.supports.length}</span>
        <span className={solverError > 1 ? "warning-text" : ""}>
          Errore solver {solverError.toFixed(4)}
        </span>
      </div>

      {node && (
        <div className="inspector-section">
          <h2>{node.label}</h2>
          <Field label="Etichetta" value={node.label} onChange={(value) => onUpdateNode({ ...node, label: value })} />
          <Field
            label="X"
            type="number"
            value={node.x}
            onChange={(value) => onUpdateNode({ ...node, x: Number(value) })}
          />
          <Field
            label="Y"
            type="number"
            value={node.y}
            onChange={(value) => onUpdateNode({ ...node, y: Number(value) })}
          />
          <label className="field">
            <span>Tipo nodo</span>
            <select value={node.kind} onChange={(event) => onUpdateNode({ ...node, kind: event.target.value as MechanismNode["kind"] })}>
              <option value="point">Nodo</option>
              <option value="hinge">Cerniera</option>
            </select>
          </label>
          <label className="field">
            <span>Vincolo terreno</span>
            <select
              value={nodeSupport?.type ?? "none"}
              onChange={(event) => onChangeNodeSupport(node.id, event.target.value === "none" ? null : event.target.value as SupportType)}
            >
              <option value="none">Libero</option>
              <option value="fixed">Fisso a terra</option>
              <option value="slider">Carrello su guida</option>
            </select>
          </label>
          <div className="inspector-note">
            {nodeSupport?.type === "fixed" && "Questo nodo resta vincolato al terreno."}
            {nodeSupport?.type === "slider" && "Questo nodo resta vincolato a una guida. Seleziona il vincolo per impostarne l'angolo."}
            {!nodeSupport && "Nodo libero: puoi trasformarlo in cerniera a terra o carrello direttamente da qui."}
          </div>
        </div>
      )}

      {bar && !bar.auxiliary && (
        <div className="inspector-section">
          <h2>{bar.label}</h2>
          <Field label="Etichetta" value={bar.label} onChange={(value) => onUpdateBar({ ...bar, label: value })} />
          <Field
            label="Lunghezza rigida"
            type="number"
            value={bar.length}
            onChange={(value) => onUpdateBar({ ...bar, length: Math.max(10, Number(value)) })}
          />
          <Field label="Colore" value={bar.color} onChange={(value) => onUpdateBar({ ...bar, color: value })} />
          <div className="inspector-note">
            Distanza attuale:{" "}
            {(() => {
              const a = getNode(model, bar.nodeA);
              const b = getNode(model, bar.nodeB);
              return a && b ? distance(a, b).toFixed(2) : "-";
            })()}
          </div>
          <div className="inspector-note">Se aggiungi una cerniera sopra questa asta, il nuovo nodo viene incorporato al corpo rigido senza spezzare l'asta visibile e puo diventare un perno a terra.</div>
        </div>
      )}

      {support && (
        <div className="inspector-section">
          <h2>{support.label}</h2>
          <label className="field">
            <span>Tipo</span>
            <select
              value={support.type}
              onChange={(event) => onUpdateSupport({ ...support, type: event.target.value as MechanismSupport["type"], label: event.target.value === "fixed" ? "Supporto fisso" : "Carrello" })}
            >
              <option value="fixed">Fisso</option>
              <option value="slider">Carrello</option>
            </select>
          </label>
          <Field
            label="Ancora X"
            type="number"
            value={support.anchorX}
            onChange={(value) => onUpdateSupport({ ...support, anchorX: Number(value) })}
          />
          <Field
            label="Ancora Y"
            type="number"
            value={support.anchorY}
            onChange={(value) => onUpdateSupport({ ...support, anchorY: Number(value) })}
          />
          <Field
            label="Angolo guida"
            type="number"
            value={support.angle}
            onChange={(value) => onUpdateSupport({ ...support, angle: Number(value) })}
          />
        </div>
      )}

      {!selection && (
        <div className="empty-state">
          <h2>Nessun elemento selezionato</h2>
          <p>
            Seleziona un nodo, una barra o un vincolo per modificarne le proprieta. Con lo strumento cerniera puoi anche cliccare sopra un'asta per aggiungere un perno strutturalmente agganciato al corpo rigido.
          </p>
        </div>
      )}
    </aside>
  );
}

