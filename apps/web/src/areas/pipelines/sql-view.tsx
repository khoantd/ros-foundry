import { useEffect, useMemo, useState } from "react";
import { AlignLeft, Check, Copy } from "lucide-react";
import { Button } from "../../kit";
import { useWorkspace } from "../../ui";
import { beautifySql, tokenizeSql, type SqlToken } from "./beautify-sql";

function tokenClass(kind: SqlToken["kind"]) {
  switch (kind) {
    case "kw":
      return "pp-sql-kw";
    case "str":
      return "pp-sql-str";
    case "num":
      return "pp-sql-num";
    case "id":
      return "pp-sql-id";
    case "punct":
      return "pp-sql-punct";
    default:
      return undefined;
  }
}

function HighlightedSql({ sql }: { sql: string }) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);
  return (
    <code>
      {tokens.map((t, i) => {
        const cls = tokenClass(t.kind);
        return cls ? (
          <span key={i} className={cls}>
            {t.value}
          </span>
        ) : (
          <span key={i}>{t.value}</span>
        );
      })}
    </code>
  );
}

function CopySqlButton({ text }: { text: string }) {
  const { notify } = useWorkspace();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon={copied ? Check : Copy}
        className="pp-sql-action"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            notify("Couldn’t copy. Select the SQL and copy it instead.", true);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <span className="rosf-sr-only" aria-live="polite">
        {copied ? "SQL copied" : ""}
      </span>
    </>
  );
}

/** Read-only beautified SQL with syntax tokens and copy. */
export function SqlView({
  sql,
  hint = "Formatted for reading",
}: {
  sql: string;
  hint?: string;
}) {
  const pretty = useMemo(() => beautifySql(sql || ""), [sql]);
  return (
    <div className="pp-sql-view">
      <div className="pp-sql-view-head">
        <span>{hint}</span>
        <CopySqlButton text={pretty} />
      </div>
      <pre tabIndex={0} aria-label="SQL" className="pp-sql-view-body">
        <HighlightedSql sql={pretty} />
      </pre>
    </div>
  );
}

/** Format control for editable SQL textareas. */
export function FormatSqlButton({
  value,
  onFormat,
}: {
  value: string;
  onFormat: (next: string) => void;
}) {
  const pretty = beautifySql(value || "");
  const disabled = !value.trim() || pretty === value;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      icon={AlignLeft}
      className="pp-sql-action"
      disabled={disabled}
      title={disabled ? "SQL is already formatted" : "Beautify SQL indentation"}
      onClick={() => onFormat(pretty)}
    >
      Format
    </Button>
  );
}
