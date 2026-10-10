import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./ld/push";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { applyTheme, cachedTheme } from "./ld/theme";

// Appearance before the first paint, from what this device remembers; the account's choice takes over once it loads.
applyTheme(cachedTheme());

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/** A request refused for a missing or expired session sends the person back to sign in. */
const handleUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
  queryClient.setQueryData([["auth", "me"], { type: "query" }], null);
  queryClient.invalidateQueries({ queryKey: [["auth", "me"]] });
};

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") handleUnauthorized(event.query.state.error);
});
queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") handleUnauthorized(event.mutation.state.error);
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, { ...(init ?? {}), credentials: "same-origin" });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);

// The service worker shows push notices and opens the right screen when one is tapped.
if (import.meta.env.PROD) window.addEventListener("load", () => registerServiceWorker());
