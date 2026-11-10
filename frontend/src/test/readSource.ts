/** Reads a file under src/ in a test (CSS imports, even `?raw`, are empty under Vitest).
 * Paths are relative to the frontend folder, where Vitest runs. */
export async function readSource(pathInSrc: string): Promise<string> {
  const fsModule = "node:fs"; // a variable, so the browser tsconfig doesn't need Node types
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: "utf8"): string;
  };
  return readFileSync(`src/${pathInSrc}`, "utf8");
}
