import type { Report } from "@shared/types";

/** Plain-text version of the buy list, for pasting into an email or a purchasing form. */
export function buyListToText(report: Report): string {
  const heading = `Buy / feature list: ${report.place} (${report.audience})`;
  const lines = report.buyList.map((item) => {
    const year = item.book.year ? ` (${item.book.year})` : "";
    return `${item.rank}. ${item.book.name}${year}\n   ${item.rationale}`;
  });
  return [heading, ...(report.budgetNote ? [report.budgetNote] : []), "", ...lines].join("\n");
}

/** A spreadsheet that opens a cell starting with = + - @ as a formula; a leading apostrophe neutralises that. */
function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const CSV_COLUMNS = ["rank", "title", "year", "rationale", "matched_signals"] as const;

export function buyListToCsv(report: Report): string {
  const rows = report.buyList.map((item) => [
    String(item.rank),
    safeCell(item.book.name),
    item.book.year ? String(item.book.year) : "",
    safeCell(item.rationale),
    safeCell(item.evidence.matchedSignals.map((signal) => signal.name).join("; ")),
  ]);
  return [CSV_COLUMNS.join(","), ...rows.map((row) => row.map(csvField).join(","))].join("\r\n") + "\r\n";
}

export function csvFileName(report: Report): string {
  const slug = report.place
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `shelfwise-buy-list-${slug || "report"}-v${report.version}.csv`;
}

/** Client-side download; nothing is sent over the network. The BOM keeps accented titles intact in Excel. */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Copies text with the async Clipboard API, falling back to a hidden textarea where it is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
