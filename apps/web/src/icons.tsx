import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  CheckmarkCircle02Icon,
  Link01Icon,
  Delete02Icon,
  Calendar03Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  KanbanIcon,
  ListViewIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";

function controlIcon(icon: ComponentProps<typeof HugeiconsIcon>["icon"]) {
  return function ControlIcon(
    props: Omit<ComponentProps<typeof HugeiconsIcon>, "icon">,
  ) {
    return <HugeiconsIcon icon={icon} size={16} {...props} />;
  };
}

export const Plus = controlIcon(Add01Icon);
export const ArrowDown = controlIcon(ArrowDown01Icon);
export const ArrowUp = controlIcon(ArrowUp01Icon);
export const Columns3 = controlIcon(KanbanIcon);
export const List = controlIcon(ListViewIcon);
export const Settings2 = controlIcon(Settings01Icon);

export const Save = controlIcon(FloppyDiskIcon);
export const Check = controlIcon(CheckmarkCircle02Icon);
export const LinkIcon = controlIcon(Link01Icon);
export const Trash2 = controlIcon(Delete02Icon);
export const Calendar = controlIcon(Calendar03Icon);
