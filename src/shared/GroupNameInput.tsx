import { useId, type InputHTMLAttributes } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & { groups: readonly string[] };

export function GroupNameInput({ groups, list, ...props }: Props) {
  const id = useId();
  const listId = list || `group-options-${id}`;
  const options = [...new Set(groups.map(group => group.trim()).filter(group => group && group !== "未分组"))];
  return <>
    <input autoComplete="off" placeholder="选择已有分组或输入新分组" {...props} list={listId} />
    <datalist id={listId}>{options.map(group => <option key={group} value={group} />)}</datalist>
  </>;
}
