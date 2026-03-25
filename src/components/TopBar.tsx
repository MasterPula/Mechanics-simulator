interface TopBarProps {
  snapToGrid: boolean;
  showGrid: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onToggleSnap: () => void;
  onToggleGrid: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onNewProject: () => void;
  onLoad: () => void;
  onSave: () => void;
  onResetMechanism: () => void;
}

export function TopBar({
  snapToGrid,
  showGrid,
  canUndo,
  canRedo,
  onToggleSnap,
  onToggleGrid,
  onUndo,
  onRedo,
  onNewProject,
  onLoad,
  onSave,
  onResetMechanism,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Mechanics Simulator</p>
        <h1>Editor e simulatore di meccanismi piani</h1>
      </div>

      <div className="topbar-actions">
        <button type="button" className="secondary-button icon-button" onClick={onUndo} disabled={!canUndo} title="Indietro (Ctrl+Z)">
          ↶
        </button>
        <button type="button" className="secondary-button icon-button" onClick={onRedo} disabled={!canRedo} title="Avanti (Ctrl+Y)">
          ↷
        </button>
        <button type="button" className="primary-button" onClick={onNewProject}>
          Nuovo progetto
        </button>
        <button type="button" className="secondary-button" onClick={onSave}>
          Salva JSON
        </button>
        <button type="button" className="secondary-button" onClick={onLoad}>
          Carica JSON
        </button>
        <button type="button" className="secondary-button" onClick={onResetMechanism}>
          Reset meccanismo
        </button>
        <label className="toggle-chip">
          <input type="checkbox" checked={snapToGrid} onChange={onToggleSnap} />
          Snap griglia
        </label>
        <label className="toggle-chip">
          <input type="checkbox" checked={showGrid} onChange={onToggleGrid} />
          Griglia
        </label>
      </div>
    </header>
  );
}
