import type { LucideIcon } from "lucide-react";

export interface PetActionGroup {
  label: string;
  actions: {
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    count?: number;
    title?: string;
    disabled?: boolean;
    danger?: boolean;
  }[];
}

export function PetActionGroups({ groups }: { groups: PetActionGroup[] }) {
  return <div className="pet-action-groups">
    {groups.map(group => <section key={group.label} className="pet-action-group" aria-label={group.label}>
      <h2>{group.label}</h2>
      <div className="pet-action-grid">
        {group.actions.map(({ icon: Icon, label, title, count, disabled, danger, onClick }) =>
          <button key={label} type="button" title={title} disabled={disabled} data-danger={danger || undefined} onClick={onClick}>
            <span className="pet-action-icon"><Icon size={16} aria-hidden="true" /></span>
            <span className="pet-action-label">{label}</span>
            {count !== undefined && <span className="pet-action-count">{count}</span>}
          </button>,
        )}
      </div>
    </section>)}
  </div>;
}
