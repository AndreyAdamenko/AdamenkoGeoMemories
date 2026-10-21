// Warm only the first visible rows; the rest of the filmstrip stays lazy-loaded.
export async function warmPreviews(ids: string[], signal: AbortSignal) {
  await Promise.all(
    ids.slice(0, 12).map(
      (id) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const image = new Image();
          let timer: ReturnType<typeof setTimeout>;
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            image.onload = image.onerror = null;
            resolve();
          };
          const abort = () => {
            image.src = "";
            finish();
          };
          signal.addEventListener("abort", abort, { once: true });
          image.onload = image.onerror = finish;
          timer = setTimeout(finish, 800);
          image.src = `/api/photos/${id}/preview`;
        }),
    ),
  );
}
