import type { ComponentProps } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import "./pet-dialog.css";

type SharedDialogProps = ComponentProps<typeof SharedDialog>;

/** 桌宠弹层：复用公共弹层的关闭、Esc、焦点循环与拖动，仅切换为与快捷菜单一致的紧凑外观。 */
export function PetDialog(props: Omit<SharedDialogProps, "variant" | "size" | "showResize" | "resizable">) {
  return <SharedDialog {...props} variant="pet" size="small" showResize={false} resizable={false} />;
}

/** 桌宠确认框：标题栏拖动只移动弹层本身，不再拖动整个桌宠窗口。 */
export function PetConfirmDialog(props: Omit<ComponentProps<typeof ConfirmDialog>, "variant" | "onPointerDown">) {
  return <ConfirmDialog {...props} variant="pet" />;
}
