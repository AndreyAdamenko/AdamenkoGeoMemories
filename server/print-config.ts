import { loadConfig } from "./config.ts";

// A file entry point avoids Windows PowerShell 5.1 stripping quotes in --eval.
// Native stdout is decoded using the console code page by Windows PowerShell
// 5.1. ASCII JSON escapes keep Cyrillic paths intact in OEM/ANSI consoles too.
console.log(
  JSON.stringify(loadConfig()).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ),
);
