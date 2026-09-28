export function renderGuides(options?: {
  root?: string;
  stylesheets?: string[];
  guides?: { source: string; output: string }[];
}): Promise<Map<string, string>>;

export function frontendGuides(): {
  name: string;
  apply: "build";
  generateBundle: {
    order: "post";
    handler(
      this: {
        emitFile(asset: {
          type: "asset";
          fileName: string;
          source: string;
        }): string;
      },
      options: unknown,
      bundle: Record<string, { type: string; fileName: string }>,
    ): Promise<void>;
  };
};
