import { useI18n } from "../i18n/context";

export function StatusBar({
  connected,
  connectionCount,
}: {
  connected: boolean;
  connectionCount: number;
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-3 text-xs text-[var(--r-text-muted)]">
      <div className="flex items-center gap-1.5">
        <span
          className={`w-2 h-2 rounded-full animate-pulse ${
            connected ? "bg-green-500" : "bg-red-500"
          }`}
        />
        <span>
          {connected ? t("live") : t("connecting")}
        </span>
      </div>
      {connected && connectionCount > 0 && (
        <span>
          {connectionCount} {connectionCount !== 1 ? t("viewers") : t("viewer")}
        </span>
      )}
    </div>
  );
}
