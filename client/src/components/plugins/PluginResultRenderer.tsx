import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { PluginResultFieldDefinition, PluginResultSchemaDefinition } from "@shared/pluginTypes";
import { Clipboard, ExternalLink, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

function valueAtPath(value: unknown, path?: string) {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function displayValue(value: unknown, field: PluginResultFieldDefinition) {
  if (value === undefined || value === null || value === "") return "-";
  if (field.type === "datetime") {
    const date = new Date(value as any);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  if (typeof value === "boolean") return value ? field.trueLabel || "是" : field.falseLabel || "否";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "-";
    }
  }
  return String(value);
}

function statusTone(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "ok", "online", "active", "running", "success", "applied", "effective", "enabled"].includes(normalized)) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (["false", "error", "offline", "inactive", "failed", "timeout", "disabled"].includes(normalized)) {
    return "border-destructive/25 bg-destructive/10 text-destructive";
  }
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

function safeExternalUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function PluginResultRenderer({
  data,
  schema,
  canRevealSecrets,
}: {
  data: unknown;
  schema: PluginResultSchemaDefinition;
  canRevealSecrets: boolean;
}) {
  const [revealed, setRevealed] = useState<string[]>([]);
  const base = valueAtPath(data, schema.resultPath);

  const copy = async (value: unknown, field: PluginResultFieldDefinition) => {
    await navigator.clipboard.writeText(displayValue(value, field));
    toast.success("已复制");
  };

  const renderValue = (value: unknown, field: PluginResultFieldDefinition, revealKey: string) => {
    const isRevealed = revealed.includes(revealKey);
    const secret = field.secret === true;
    const text = secret && !isRevealed ? "••••••••" : displayValue(value, field);
    const url = field.openable ? safeExternalUrl(value) : "";
    if (field.type === "boolean") {
      return <Switch checked={value === true} disabled aria-label={field.label} />;
    }
    if (field.type === "statusBadge") {
      return <Badge variant="outline" className={statusTone(value)}>{text}</Badge>;
    }
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("truncate", field.type === "code" && "font-mono text-xs")} title={secret && !isRevealed ? undefined : displayValue(value, field)}>{text}</span>
        {secret && field.revealable && canRevealSecrets && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            title={isRevealed ? "隐藏" : "显示"}
            onClick={() => setRevealed((items) => isRevealed ? items.filter((item) => item !== revealKey) : [...items, revealKey])}
          >
            {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        )}
        {field.copyable && (!secret || isRevealed) && (
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" title="复制" onClick={() => copy(value, field)}>
            <Clipboard className="h-3.5 w-3.5" />
          </Button>
        )}
        {url && (!secret || isRevealed) && (
          <Button asChild variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" title="打开">
            <a href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a>
          </Button>
        )}
      </div>
    );
  };

  if (schema.type === "table") {
    const itemsValue = valueAtPath(base, schema.itemsPath);
    const rows = Array.isArray(itemsValue) ? itemsValue : Array.isArray(base) ? base : [];
    return (
      <div className="overflow-hidden rounded-md border border-border/50">
        <Table>
          <TableHeader>
            <TableRow>{schema.fields.map((field) => <TableHead key={field.key}>{field.label}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: any, rowIndex: number) => (
              <TableRow key={String(row?.id ?? row?.key ?? rowIndex)}>
                {schema.fields.map((field) => (
                  <TableCell key={field.key} className="max-w-80">
                    {renderValue(valueAtPath(row, field.path || field.key), field, `${rowIndex}:${field.key}`)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!rows.length && <TableRow><TableCell colSpan={schema.fields.length} className="h-20 text-center text-muted-foreground">{schema.emptyText || "暂无数据"}</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    );
  }

  const record = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return (
    <div className="grid overflow-hidden rounded-md border border-border/50 sm:grid-cols-2">
      {schema.fields.map((field) => {
        const value = valueAtPath(record, field.path || field.key);
        return (
          <div key={field.key} className="min-w-0 border-b border-border/40 px-3 py-2.5 last:border-b-0 sm:[&:nth-child(odd)]:border-r">
            <p className="mb-1 text-xs text-muted-foreground">{field.label}</p>
            {renderValue(value, field, field.key)}
          </div>
        );
      })}
    </div>
  );
}
