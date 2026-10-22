import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { photoLink } from "./photo-links";
import { isPublicHostname } from "./access";

export function CopyPhotoLink({
  id,
  compact = false,
}: {
  id: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [manual, setManual] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
    setManual("");
    return () => clearTimeout(timer.current);
  }, [id]);
  const copy = async () => {
    const url = photoLink(id, window.location.origin);
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setManual("");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 3500);
    } catch {
      setManual(url);
    }
  };
  return (
    <span className={`copy-photo-link ${compact ? "compact" : ""}`}>
      <button
        type="button"
        className={compact ? "" : "text-button"}
        onClick={copy}
        aria-label={
          copied ? "Ссылка скопирована" : "Скопировать ссылку на фото и карту"
        }
        title="Скопировать ссылку на фото и карту"
      >
        <Icon name={copied ? "check" : "link"} size={compact ? 20 : 16} />
        {!compact && (copied ? "Скопировано" : "Скопировать ссылку")}
      </button>
      {copied && (
        <span className="copy-link-message" role="status">
          {isPublicHostname(window.location.hostname)
            ? "Ссылка скопирована"
            : "Локальная ссылка скопирована. Для отправки откройте публичную галерею."}
        </span>
      )}
      {manual && (
        <label className="copy-link-manual">
          Скопируйте ссылку
          <input
            aria-label="Ссылка на фотографию"
            readOnly
            value={manual}
            onFocus={(e) => e.target.select()}
            autoFocus
          />
        </label>
      )}
    </span>
  );
}
