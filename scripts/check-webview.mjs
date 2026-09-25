/*
 * Dev guards for the webview half, covering two mistakes that neither jsdom nor
 * a compiler can catch:
 *
 *  1. the client looking up an id that the shell never declares;
 *  2. an element the client hides with the `hidden` attribute while the
 *     stylesheet declares `display` on it — which silently wins over the UA
 *     rule, so the element stays visible no matter what the client does.
 *
 *   node scripts/check-webview.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const client = fs.readFileSync(path.join(root, "media", "reader.js"), "utf8");
const css = fs.readFileSync(path.join(root, "media", "reader.css"), "utf8");
const shell = fs.readFileSync(path.join(root, "src", "editor", "shell.ts"), "utf8");

let failed = false;

/* --------------------------------------------------------- id contract --- */

const ids = (source, pattern) => {
  const found = new Set();
  for (const match of source.matchAll(pattern)) {
    found.add(match[1]);
  }
  return found;
};

const requested = ids(client, /\$\("([^"]+)"\)/g);
const declared = ids(shell, /\sid="([^"]+)"/g);
const missing = [...requested].filter((id) => !declared.has(id));

console.log(`shell ids      : ${[...declared].sort().join(", ")}`);
console.log(`client lookups : ${[...requested].sort().join(", ")}`);

if (missing.length > 0) {
  console.error(`\n✗ client looks up ids that the shell never declares: ${missing.join(", ")}`);
  failed = true;
} else {
  console.log("\n✓ every id the webview client uses exists in the shell");
}

/* ------------------------------------------------- hidden attribute guard - */

/** id -> classes, taken from the shell markup. */
const idClasses = new Map();
for (const tag of shell.matchAll(/<[a-z][a-z0-9]*\s([^>]*)>/gi)) {
  const attrs = tag[1];
  const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
  if (!id) {
    continue;
  }
  const classes = /\bclass="([^"]+)"/.exec(attrs)?.[1];
  idClasses.set(id, classes ? classes.split(/\s+/).filter(Boolean) : []);
}

/** dom.<name> -> the id it was bound to. */
const bindings = new Map(
  [...client.matchAll(/dom\.(\w+)\s*=\s*\$\("([^"]+)"\)/g)].map((match) => [match[1], match[2]]),
);

/** ids the client toggles through the `hidden` attribute. */
const hiddenTargets = new Set();
for (const match of client.matchAll(/dom\.(\w+)\.hidden\s*=/g)) {
  const id = bindings.get(match[1]);
  if (id) {
    hiddenTargets.add(id);
  }
}

/** Selector tokens of every rule that declares `display`. */
const displaySelectors = [];
for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/(^|[;\s])display\s*:/.test(rule[2])) {
    continue;
  }
  const head = rule[1].slice(rule[1].lastIndexOf("}") + 1);
  for (const selector of head.split(",")) {
    const trimmed = selector.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("@")) {
      displaySelectors.push(trimmed);
    }
  }
}

const vulnerable = [];
for (const id of hiddenTargets) {
  const tokens = [`#${id}`, ...(idClasses.get(id) ?? []).map((name) => `.${name}`)];
  const matched = displaySelectors.filter((selector) =>
    tokens.some((token) => selector.includes(token)),
  );
  if (matched.length > 0) {
    vulnerable.push(`${id} <- ${matched.join(", ")}`);
  }
}

const hasGuard = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(css);
console.log(`\nhidden targets : ${[...hiddenTargets].sort().join(", ")}`);
if (vulnerable.length > 0) {
  console.log(`display conflicts: \n  ${vulnerable.join("\n  ")}`);
}

if (vulnerable.length > 0 && !hasGuard) {
  console.error(
    "\n✗ some elements set `display` in CSS while the client hides them with the `hidden`\n" +
      "  attribute; without an explicit `[hidden] { display: none }` rule they stay visible.",
  );
  failed = true;
} else if (vulnerable.length > 0) {
  console.log("✓ the [hidden] guard covers the display conflicts above");
} else {
  console.log("✓ no element combines a hidden toggle with a CSS display rule");
}

process.exit(failed ? 1 : 0);
