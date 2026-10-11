import { formatScope, type ops } from "@storage/core";
import type { z } from "zod";

type Out<S extends { output: z.ZodType }> = z.output<S["output"]>;

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function table(rows: string[][]): string {
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

function grantWho(g: {
  principal: string;
  email: string | null;
  github_login: string | null;
  name: string | null;
}): string {
  if (g.email) {
    return `${g.principal} <${g.email}>`;
  }
  const label = g.github_login ?? g.name;
  return label && label !== g.principal.slice(g.principal.indexOf(":") + 1) ? `${g.principal} (${label})` : g.principal;
}

const formatters: Record<string, (output: never) => string> = {
  whoami: (o: Out<typeof ops.whoami>) =>
    [
      o.principal,
      ...o.orgs.map((org) => `  ${org.slug} (${org.role})`),
      ...o.connected.map((account) => `  connected: ${account.provider} ${account.login}`),
      ...o.groups.map((group) => `  group: ${group.name} (${group.principal})`),
      o.link === null
        ? `token ${o.token.id}: ${o.token.scopes === null ? "full access" : `scopes ${o.token.scopes.map(formatScope).join(", ")}`}`
        : `share link for ${o.link.uri} (expires ${o.token.expires_at ?? "never"})`,
    ].join("\n"),

  collections: (o: Out<typeof ops.collections>) =>
    o.collections.length === 0
      ? "No collections."
      : table(o.collections.map((c) => [c.uri, c.title ?? "", c.created_at])) +
        (o.next_cursor ? `\n(more: --cursor ${o.next_cursor})` : ""),

  grants: (o: Out<typeof ops.grants>) =>
    o.grants.length === 0
      ? `No grants on ${o.uri}`
      : `${o.uri}\n${table(o.grants.map((g) => [grantWho(g), g.role, g.level]))}`,

  share: (o: Out<typeof ops.share>) =>
    o.changed
      ? `Granted ${o.grant.role} on ${o.grant.uri} to ${o.grant.principal}` +
        (o.previous_role ? ` (was ${o.previous_role})` : "")
      : `${o.grant.principal} already has ${o.grant.role} on ${o.grant.uri}`,

  unshare: (o: Out<typeof ops.unshare>) =>
    `Removed ${o.removed.principal}'s ${o.removed.role} grant on ${o.removed.uri}`,

  audit: (o: Out<typeof ops.audit>) =>
    o.events.length === 0
      ? "No events."
      : table(o.events.map((e) => [e.at, e.action, e.actor, e.target])) +
        (o.next_cursor ? `\n(more: --cursor ${o.next_cursor})` : ""),

  create: (o: Out<typeof ops.create>) => `${o.created ? "Created" : "Already exists:"} ${o.uri}`,

  list: (o: Out<typeof ops.list>) => {
    const rows = [
      ...o.prefixes.map((p) => [
        p.path,
        `${p.object_count} object${p.object_count === 1 ? "" : "s"}`,
        formatSize(p.total_size),
        "",
      ]),
      ...o.objects.map((obj) => [obj.path, `v${obj.version}`, formatSize(obj.size), obj.content_type]),
    ];
    const body = rows.length === 0 ? `Nothing under ${o.uri}` : table(rows);
    return body + (o.next_cursor ? `\n(more: --cursor ${o.next_cursor})` : "");
  },

  stat: (o: Out<typeof ops.stat>) =>
    table([
      ["uri", `${o.uri}@${o.version}${o.version === o.current_version ? " (current)" : ""}`],
      ["size", `${formatSize(o.size)} (${o.size} bytes)`],
      ["content_type", o.content_type],
      ["sha256", o.sha256],
      ["uploaded", `${o.uploaded_at} by ${o.uploaded_by}`],
      ...(o.description ? [["description", o.description]] : []),
      ...Object.entries(o.meta).map(([key, value]) => [`meta.${key}`, value]),
    ]),

  history: (o: Out<typeof ops.history>) =>
    table(
      o.versions.map((v) => [
        `v${v.version}${v.version === o.current_version ? "*" : ""}`,
        formatSize(v.size),
        v.sha256.slice(0, 12),
        v.uploaded_at,
        v.uploaded_by,
      ]),
    ),

  put: (o: Out<typeof ops.put>) =>
    `Uploaded ${o.uri}@${o.version} (${formatSize(o.size)}${o.deduplicated ? ", content already stored" : ""})`,

  get: (o: Out<typeof ops.get>) => o.path ?? o.url ?? "",

  push: (o: Out<typeof ops.push>) => {
    const verb = o.dry_run ? "would upload" : "uploaded";
    const deleted = o.dry_run ? "would delete" : "deleted";
    const summary =
      `${o.dry_run ? "Dry run, nothing changed. " : ""}${o.uri}: ` +
      `${o.uploaded.length} ${verb}, ${o.unchanged} unchanged, ${o.deleted.length} ${deleted}` +
      (o.skipped.length > 0 ? `, ${o.skipped.length} skipped` : "");
    const rows = [
      ...o.uploaded.map((u) => [
        `  ${verb}`,
        u.path,
        u.version === undefined ? formatSize(u.size) : `v${u.version}, ${formatSize(u.size)}`,
      ]),
      ...o.deleted.map((d) => [`  ${deleted}`, d.path, ""]),
      ...o.skipped.map((s) => ["  skipped", s.local_path, s.reason]),
    ];
    return rows.length === 0 ? summary : `${summary}\n${table(rows)}`;
  },

  pull: (o: Out<typeof ops.pull>) => {
    const downloaded = o.files.filter((f) => f.downloaded).length;
    const summary =
      `Pulled ${o.files.length} file${o.files.length === 1 ? "" : "s"} from ${o.uri} into ${o.to}` +
      (o.files.length > 0 ? ` (${downloaded} downloaded, ${o.files.length - downloaded} already present)` : "");
    return [
      summary,
      ...o.files.map((f) => (f.renamed ? `${f.local_path} (renamed from ${f.path})` : f.local_path)),
    ].join("\n");
  },

  delete: (o: Out<typeof ops.del>) =>
    o.deleted.length === 0
      ? "Nothing deleted."
      : [
          `Deleted ${o.deleted.length} object${o.deleted.length === 1 ? "" : "s"}:`,
          ...o.deleted.map((d) => `  ${d.uri}`),
        ].join("\n"),

  restore: (o: Out<typeof ops.restore>) =>
    o.restored.length === 0
      ? "Nothing to restore."
      : o.restored.map((r) => `Restored ${r.uri} (version ${r.version})`).join("\n"),
};

export function formatHuman(operation: string, output: unknown): string {
  const formatter = formatters[operation];
  return formatter ? formatter(output as never) : JSON.stringify(output, null, 2);
}
