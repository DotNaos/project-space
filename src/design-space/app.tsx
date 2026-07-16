export function ProjectSpaceDesignPreview() {
  const previewUrl = import.meta.env.VITE_PROJECT_SPACE_PREVIEW_URL as string | undefined;
  if (!previewUrl) {
    return (
      <main className="grid h-full min-h-screen place-items-center bg-app-canvas px-8 text-center text-neutral-200">
        <div>
          <h1 className="text-sm font-semibold">Project Space preview is not running</h1>
          <p className="mt-2 text-xs text-neutral-500">Start the local Project Space app server and restart this Design Space target.</p>
        </div>
      </main>
    );
  }
  return (
    <iframe
      className="block h-full min-h-screen w-full border-0 bg-app-canvas"
      src={previewUrl}
      title="Project Space live app"
    />
  );
}
