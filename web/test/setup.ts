/**
 * bun test preload (see ../bunfig.toml): a happy-dom DOM, CSS imports, and the React act() flag.
 */
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom replaces the global timers with its own wrappers; keep Bun's so jest fake timers
// drive exactly the timers the code under test creates.
const timers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

GlobalRegistrator.register({ url: "http://localhost:3001/" });
Object.assign(globalThis, timers);

// CSS modules resolve to a proxy that echoes the class name ("styles.row" -> "row"),
// so tests can select on the names the stylesheet uses. Plain .css imports are no-ops.
plugin({
  name: "css-modules-as-class-names",
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, () => ({
      loader: "object",
      exports: {
        default: new Proxy({} as Record<string, string>, {
          get: (_t, key) => (typeof key === "string" ? key : undefined),
        }),
      },
    }));
    build.onLoad({ filter: /\.css$/ }, () => ({ loader: "object", exports: { default: {} } }));
  },
});

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; __JEV_WEB_TEST__?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;
// Test files skip themselves without this flag, so a `bun test` run from the repo root
// (which does not load this preload) does not fail on the web tests.
g.__JEV_WEB_TEST__ = true;
