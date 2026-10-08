type BundleOutput =
  | { type: "chunk"; modules: Record<string, { renderedLength: number }> }
  | { type: "asset"; fileName: string; originalFileNames: string[] };

export function collectFrontendNotices(options: {
  root: string;
  moduleIds: string[];
}): string;

export function frontendNotices(options?: { root?: string }): {
  name: string;
  apply: "build";
  enforce: "pre";
  configResolved(config: {
    createResolver(options: {
      extensions: string[];
      mainFields: string[];
      conditions: string[];
      preferRelative: boolean;
      tryIndex: boolean;
    }): (id: string, importer: string) => Promise<string | undefined>;
  }): void;
  buildStart(): void;
  transform(code: string, id: string): Promise<void>;
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
      bundle: Record<string, BundleOutput>,
    ): void;
  };
};
