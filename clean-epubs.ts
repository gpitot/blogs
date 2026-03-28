import { rmSync } from "node:fs";

rmSync("epubs", { recursive: true, force: true });
rmSync("epubs_zipped", { recursive: true, force: true });

console.log("Cleaned epubs/ and epubs_zipped/");
