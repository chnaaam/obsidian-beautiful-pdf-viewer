import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

// Stub node: builtins that ppdf only uses when given a file path (we pass Uint8Array).
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "stub-node",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-node" }, () => ({
      contents:
        "export const readFile = async () => { throw new Error('node fs not available in browser'); };\nexport default {};",
      loader: "js",
    }));
  },
};

// ppdf source files import each other with .js extensions (NodeNext style).
// Rewrite those to .ts when bundling ppdf's src directly.
const ppdfRoot = path.resolve(__dirname, "ppdf/src");
const ppdfResolver = {
  name: "ppdf-ts-resolver",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer.startsWith(ppdfRoot)) return null;
      const candidate = path.resolve(path.dirname(args.importer), args.path.replace(/\.js$/, ".ts"));
      return { path: candidate };
    });
  },
};

// Resolve pdfjs-dist by looking inside ppdf/node_modules since ppdf is the one that declares it.
const pdfjsResolver = {
  name: "pdfjs-resolver",
  setup(build) {
    const requireFromPpdf = createRequire(path.resolve(__dirname, "ppdf/package.json"));
    build.onResolve({ filter: /^pdfjs-dist(\/|$)/ }, (args) => {
      if (args.namespace && args.namespace !== "file") return null;
      try {
        return { path: requireFromPpdf.resolve(args.path) };
      } catch {
        return null;
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.resolve(__dirname, "src/main.ts")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  outfile: path.resolve(__dirname, "main.js"),
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  resolveExtensions: [".ts", ".tsx", ".mjs", ".js"],
  define: {
    "import.meta.url": JSON.stringify("file:///beautiful-pdf-viewer/"),
  },
  plugins: [stubNodeBuiltins, ppdfResolver, pdfjsResolver],
  sourcemap: prod ? false : "inline",
  minify: prod,
  logLevel: "info",
  treeShaking: true,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
