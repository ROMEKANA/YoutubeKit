import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { descriptionParts } from "./timestamps";
import { request } from "./useCatalog";

export function VideoDescription({
  videoId,
  duration,
  onSeek,
  consent,
}: {
  videoId: string;
  consent?: ReactNode;
  duration: number;
  onSeek: (id: string, seconds: number) => boolean;
}) {
  const regionId = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState<string>();
  const [error, setError] = useState("");
  const [seekError, setSeekError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const parts = useMemo(
    () => descriptionParts(description ?? ""),
    [description],
  );

  useEffect(() => {
    if (!open || consent || description !== undefined) return;
    const controller = new AbortController();
    void request(`/api/videos/${videoId}/description`, {}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const value = (data as { description?: unknown }).description;
        if (typeof value !== "string")
          throw new Error("概要欄の応答を読み込めませんでした。");
        setDescription(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "概要欄を取得できませんでした。",
          );
      });
    return () => controller.abort();
  }, [open, description, attempt, videoId, consent]);

  return (
    <section className="video-description">
      <h2>
        <button
          ref={heading}
          className="description-toggle"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setError("");
            setSeekError("");
            setOpen(!open);
          }}
        >
          概要欄 <Icon name="chevron-down" size={18} />
        </button>
      </h2>
      <div id={regionId} hidden={!open}>
        {consent ??
          (error ? (
            <>
              <p className="panel-note" role="alert">
                {error}
              </p>
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  setAttempt((value) => value + 1);
                }}
              >
                概要欄を再取得
              </button>
            </>
          ) : description === undefined ? (
            <p className="panel-note" role="status">
              概要欄を読み込んでいます…
            </p>
          ) : description === "" ? (
            <p className="panel-note">概要欄はありません。</p>
          ) : (
            <p className="description-text">
              {parts.map(({ text, seconds, offset }) =>
                seconds === undefined ||
                (duration > 0 && seconds > duration) ? (
                  <Fragment key={offset}>{text}</Fragment>
                ) : (
                  <button
                    key={offset}
                    className="description-timestamp"
                    aria-label={`${text}へ移動`}
                    onClick={() =>
                      setSeekError(
                        onSeek(videoId, seconds)
                          ? ""
                          : "再生位置を移動できませんでした。",
                      )
                    }
                  >
                    {text}
                  </button>
                ),
              )}
            </p>
          ))}
        {seekError && (
          <p className="panel-note" role="alert">
            {seekError}
          </p>
        )}
        <button
          className="text-button"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => {
              heading.current?.focus({ preventScroll: true });
              heading.current?.scrollIntoView({
                block: "nearest",
                behavior: "smooth",
              });
            });
          }}
        >
          概要欄を閉じる
        </button>
      </div>
    </section>
  );
}
