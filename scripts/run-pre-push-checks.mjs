import { spawnSync } from "node:child_process";

const commands =
  process.platform === "win32"
    ? [
        [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run check"]],
        [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run build"]],
      ]
    : [
        ["npm", ["run", "check"]],
        ["npm", ["run", "build"]],
      ];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
