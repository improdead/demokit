#!/usr/bin/env node
// Lightweight commands must not install browsers, initialize Python, or record.
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(root, "package.json")));
const help = `DemoKit ${pkg.version} — scripted demo recordings and feature verification

Usage:
  demokit init [directory]                 Create a runnable local example
  demokit local <flow.json> <out.mp4>       Record, render, and verify
  demokit <flow.json> <out.mp4>             Alias for local
  demokit probe <url>                      Inspect a page without clicking
  demokit login <url>                      Save an authenticated browser session
  demokit skill path                       Print the bundled skill directory
  demokit skill install <directory>        Copy the skill and its references
  demokit verify <shotDir> [out.mp4]        Check recorded feature evidence
  demokit critic <shotDir> <out.mp4>        Produce frames for visual review
  demokit --render-only <shotDir> <out.mp4> Render existing frames
  demokit term <command> <out.mp4>          Execute and render a terminal command
  demokit --session <id> <flow> <out>        Legacy Playwriter capture (see docs)
  demokit --session <id> probe <url>        Inspect through real Chrome
  demokit --help | --version

Requires Node 20+, Python 3 with venv, and macOS or Linux. First recording
may download Chromium and Python packages. FFmpeg is bundled when install
scripts are allowed; a system FFmpeg/ffprobe is also supported.
Native screen/termreal capture is macOS-only. Docker box capture is experimental.
Work files: ./.demokit/ (or DEMOKIT_WORK). Read the included README for setup.
`;
try {
  if (
    command === "--help" ||
    command === "-h" ||
    command === "help" ||
    !command
  )
    console.log(help);
  else if (command === "--version" || command === "-v")
    console.log(pkg.version);
  else if (command === "init") {
    const dest = resolve(args[0] || "demokit-example");
    if (existsSync(dest))
      throw new Error(`Refusing to overwrite ${dest}; choose a new directory.`);
    mkdirSync(dest, { recursive: true });
    cpSync(
      join(root, "examples/quickstart/index.html"),
      join(dest, "index.html"),
    );
    const flow = {
      claim: "Creating a task adds it to the board.",
      url: pathToFileURL(join(dest, "index.html")).href,
      layout: [1280, 720],
      zoom: 2,
      probe: "#tasks li",
      settleMs: 400,
      tailMs: 1800,
      steps: [
        {
          do: "click",
          sel: "#create",
          label: "Create a task",
          ms: 1200,
          expect: { sel: "#tasks li" },
          shows: "The board contains the new task.",
          prove: { rowsRise: true, textAppears: "Review the demo" },
        },
      ],
    };
    writeFileSync(
      join(dest, "flow.json"),
      JSON.stringify(flow, null, 2) + "\n",
    );
    writeFileSync(join(dest, ".gitignore"), ".demokit/\nout/\n*.mp4\n");
    console.log(
      `Created ${dest}\nRun: demokit local ${JSON.stringify(join(dest, "flow.json"))} ${JSON.stringify(join(dest, "out/demo.mp4"))}`,
    );
  } else if (command === "skill" && args[0] === "path")
    console.log(join(root, "skill"));
  else if (command === "skill" && args[0] === "install" && args[1]) {
    const dest = resolve(args[1]);
    if (existsSync(dest))
      throw new Error(
        `Refusing to overwrite ${dest}; move or remove it explicitly before updating.`,
      );
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(root, "skill"), dest, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    console.log(`Installed DemoKit skill at ${dest}`);
  } else throw new Error("Unknown command. Run demokit --help.");
} catch (e) {
  console.error(`demokit: ${e.message}`);
  process.exitCode = 2;
}
