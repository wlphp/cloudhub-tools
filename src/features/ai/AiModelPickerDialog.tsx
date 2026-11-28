import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { SelectionCheckbox } from "../../shared/SortSelectionControls";

const MAX_MODELS = 20;

export function AiModelPickerDialog({
  fetched,
  configured,
  onApply,
  onClose,
}: {
  fetched: string[];
  configured: string[];
  onApply: (add: string[], remove: string[]) => void;
  onClose: () => void;
}) {
  const configuredIds = useMemo(
    () => [...new Set(configured.map(item => item.trim()).filter(Boolean))],
    [configured],
  );
  const fetchedList = useMemo(
    () => [...new Set(fetched.map(item => item.trim()).filter(Boolean))],
    [fetched],
  );
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(configuredIds));

  const fetchedSet = useMemo(() => new Set(fetchedList), [fetchedList]);
  const extraIds = useMemo(() => configuredIds.filter(id => !fetchedSet.has(id)), [configuredIds, fetchedSet]);
  const allIds = useMemo(() => [...extraIds, ...fetchedList], [extraIds, fetchedList]);

  const normalized = query.trim().toLowerCase();
  const matches = (id: string) => (!onlySelected || draft.has(id)) && (!normalized || id.toLowerCase().includes(normalized));
  const visibleExtra = extraIds.filter(matches);
  const visibleFetched = fetchedList.filter(matches);
  const visibleIds = useMemo(() => [...visibleExtra, ...visibleFetched], [visibleExtra, visibleFetched]);

  const selectedCount = allIds.filter(id => draft.has(id)).length;
  const selectedVisible = visibleIds.filter(id => draft.has(id)).length;
  const allVisible = visibleIds.length > 0 && selectedVisible === visibleIds.length;

  const setChecked = (ids: string[], checked: boolean) => {
    setDraft(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const apply = () => {
    const configuredSet = new Set(configuredIds);
    const add = fetchedList.filter(id => draft.has(id) && !configuredSet.has(id));
    const remove = configuredIds.filter(id => !draft.has(id));
    onApply(add, remove);
  };

  return (
    <SharedDialog
      sizeStorageKey="features/ai/ai-model-picker/ai-model-picker"
      title="选择可用模型"
      size="small"
      initialFocus="[type=search]"
      onClose={onClose}
      className="ai-model-catalog-dialog"
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={selectedCount > MAX_MODELS} onClick={apply}>
            应用（{selectedCount}）
          </button>
        </>
      }
    >
      <section className="ai-catalog" aria-label="可用模型列表">
        <div className="ai-catalog-toolbar">
          <label className="ai-catalog-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索可用模型"
              placeholder="搜索模型 ID"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </label>
          <label className="ai-catalog-filter">
            <input
              type="checkbox"
              checked={onlySelected}
              onChange={event => setOnlySelected(event.target.checked)}
            />
            仅看已选
          </label>
          <button
            type="button"
            className="secondary ai-catalog-clear"
            disabled={!selectedCount}
            onClick={() => setChecked(allIds, false)}
          >
            清空选择
          </button>
        </div>

        <div className="ai-catalog-results">
          <div className="ai-catalog-heading">
            <label className="ai-catalog-select-all">
              <SelectionCheckbox
                label="全选当前结果"
                checked={allVisible}
                mixed={selectedVisible > 0 && !allVisible}
                disabled={!visibleIds.length}
                onChange={() => setChecked(visibleIds, !allVisible)}
              />
              全选当前结果
            </label>
            <span role="status">
              {visibleIds.length} 个结果 · 已选 {selectedCount} / {MAX_MODELS}
            </span>
          </div>

          {visibleIds.length > 0 ? (
            <ul className="ai-catalog-list">
              {visibleExtra.length > 0 && (
                <li className="ai-catalog-group">
                  <span>已配置（不在本批上游返回）</span>
                  <span className="ai-catalog-group-count">{visibleExtra.length}</span>
                </li>
              )}
              {visibleExtra.map(id => (
                <li key={`extra-${id}`} className={`ai-catalog-item${draft.has(id) ? " is-selected" : ""}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.has(id)}
                      onChange={event => setChecked([id], event.target.checked)}
                    />
                    <code>{id}</code>
                  </label>
                </li>
              ))}

              {visibleFetched.length > 0 && visibleExtra.length > 0 && (
                <li className="ai-catalog-group">
                  <span>上游返回</span>
                  <span className="ai-catalog-group-count">{visibleFetched.length}</span>
                </li>
              )}
              {visibleFetched.map(id => (
                <li key={`fetched-${id}`} className={`ai-catalog-item${draft.has(id) ? " is-selected" : ""}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.has(id)}
                      onChange={event => setChecked([id], event.target.checked)}
                    />
                    <code>{id}</code>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ai-catalog-empty">没有匹配的模型，请换一个关键词。</p>
          )}
        </div>

        {selectedCount > MAX_MODELS && (
          <p className="ai-catalog-error" role="alert">
            每个服务最多配置 {MAX_MODELS} 个模型，请减少选择。
          </p>
        )}
      </section>
    </SharedDialog>
  );
}
