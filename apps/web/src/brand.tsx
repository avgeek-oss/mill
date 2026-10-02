export const millBrand = {
  mark: "/brand/mill-mark.png",
  themeColor: {
    light: "#faf6f3",
    dark: "#120d0b",
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
