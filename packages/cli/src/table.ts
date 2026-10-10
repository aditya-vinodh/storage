import { InvalidArgumentError } from "commander";

export function parseDays(value: string): number {
  const days = Number(value);
  if (value.trim() === "" || Number.isNaN(days)) {
    throw new InvalidArgumentError(`Expected a number, got "${value}".`);
  }
  return days;
}

export function date(iso: string): string {
  return iso.slice(0, 10);
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
