// 外から呼べる API(/api/v1/…)。中身は src/server/rest.ts
import { createFileRoute } from "@tanstack/react-router";

const handle = async ({ request, params }: { request: Request; params: { _splat?: string } }) => {
  const services = await import("~/server/instance");
  const { handleRest } = await import("~/server/rest");
  return handleRest(services, request, `/${params._splat ?? ""}`.replace(/\/+$/, ""));
};

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
