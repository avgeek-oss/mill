import { version } from "../../../package.json";

export const millVersion = version;

export const millBrand = {
  mark: "/brand/mill-mark.png",
  themeColor: {
    light: "#f7f7f6",
    dark: "#060605",
  },
} as const;

export function MillMark() {
  return (
    <img
      src={millBrand.mark}
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className="size-8 shrink-0 object-contain"
    />
  );
}
