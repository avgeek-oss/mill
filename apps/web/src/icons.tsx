import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  CheckmarkCircle02Icon,
  Link01Icon,
  Delete02Icon,
  Add01Icon,
  ClipboardListIcon,
  Settings01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";

function controlIcon(icon: ComponentProps<typeof HugeiconsIcon>["icon"]) {
  return function ControlIcon(
    props: Omit<ComponentProps<typeof HugeiconsIcon>, "icon">,
  ) {
    return <HugeiconsIcon icon={icon} size={16} {...props} />;
  };
}

export const Plus = controlIcon(Add01Icon);
export const List = controlIcon(ClipboardListIcon);
export const Settings2 = controlIcon(Settings01Icon);
export const MoreHorizontal = controlIcon(MoreHorizontalIcon);

export const Save = controlIcon(FloppyDiskIcon);
export const Check = controlIcon(CheckmarkCircle02Icon);
export const LinkIcon = controlIcon(Link01Icon);
export const Trash2 = controlIcon(Delete02Icon);
