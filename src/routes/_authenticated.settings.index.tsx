import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/")({
  ssr: false,
  beforeLoad: () => { throw redirect({ to: "/settings/integration" }); },
});
