import type { Tool } from "../types/mechanism";

interface ToolbarProps {
  activeTool: Tool;
  onToolChange: (tool: Tool) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onResetView: () => void;
}

const TOOLS: Array<{ tool: Tool; label: string; hint: string; icon: string }> = [
  { tool: "select", label: "Seleziona", hint: "Selezione e trascinamento", icon: "◎" },
  { tool: "node", label: "Nodo", hint: "Aggiungi punto libero", icon: "•" },
  { tool: "hinge", label: "Cerniera", hint: "Aggiungi giunto rotante", icon: "◉" },
  { tool: "bar", label: "Asta", hint: "Crea corpo rigido tra due nodi", icon: "╱" },
  { tool: "slider", label: "Carrello", hint: "Vincolo prismatico", icon: "⇄" },
  { tool: "fixed", label: "Fisso", hint: "Supporto a terra", icon: "⏚" },
  { tool: "delete", label: "Elimina", hint: "Rimuovi elemento", icon: "✕" },
];

export function Toolbar({ activeTool, onToolChange, onDuplicate, onDelete, onResetView }: ToolbarProps) {
  return (
    <aside className="toolbar-panel">
      <div className="panel-title">Strumenti</div>
      <div className="tool-grid">
        {TOOLS.map((item) => (
          <button
            key={item.tool}
            type="button"
            className={`tool-button ${activeTool === item.tool ? "is-active" : ""}`}
            onClick={() => onToolChange(item.tool)}
            title={item.hint}
          >
            <span className="tool-icon" aria-hidden>
              {item.icon}
            </span>
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </button>
        ))}
      </div>

      <div className="toolbar-actions">
        <button type="button" className="secondary-button" onClick={onDuplicate}>
          Duplica
        </button>
        <button type="button" className="secondary-button" onClick={onDelete}>
          Elimina selezione
        </button>
        <button type="button" className="secondary-button" onClick={onResetView}>
          Reset vista
        </button>
      </div>
    </aside>
  );
}
