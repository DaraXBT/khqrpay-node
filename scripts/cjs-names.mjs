// npm drops nested package.json files from the tarball, so the CommonJS build can't rely on one: give it .cjs names.
import { renameSync } from "node:fs";
renameSync("dist/cjs/index.js", "dist/cjs/index.cjs");
renameSync("dist/cjs/index.d.ts", "dist/cjs/index.d.cts");
