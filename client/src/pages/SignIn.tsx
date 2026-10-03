import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";

/**
 * Email-and-code sign-in, matching the approved mockup:
 * step 1 asks for an email, step 2 for the 6-digit code that was emailed.
 */
export default function SignIn() {
  const utils = trpc.useUtils();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestCode = trpc.auth.requestCode.useMutation({
    onSuccess: () => {
      setError(null);
      setCode("");
      setStep("code");
    },
    onError: (err) => setError(err.message),
  });

  const verifyCode = trpc.auth.verifyCode.useMutation({
    onSuccess: (user) => {
      utils.auth.me.setData(undefined, user);
    },
    onError: (err) => setError(err.message),
  });

  const busy = requestCode.isPending || verifyCode.isPending;

  return (
    <div className="min-h-screen bg-[#F8FAFB] text-[#14221c] flex flex-col items-center justify-center gap-4 px-4 py-10" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <div className="w-full max-w-[400px] bg-white border border-[#e3e9e6] rounded-2xl p-8 flex flex-col gap-[18px]">
        <div className="flex justify-center">
          <img src="/brand/logo-full.png" alt="LeadDash Employees" className="block h-auto w-[200px]" />
        </div>

        {step === "email" ? (
          <form
            className="flex flex-col gap-[18px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim() || busy) return;
              requestCode.mutate({ email: email.trim() });
            }}
          >
            <h1 className="m-0 text-[22px] font-extrabold">Sign in</h1>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="signin-email" className="text-[13px] font-bold text-[#3d4c45]">Email</label>
              <input
                id="signin-email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 w-full rounded-[10px] border border-[#cfd9d4] px-3.5 text-[15px] outline-none focus:border-[#1b6b4a] focus:ring-2 focus:ring-[#1b6b4a]/20"
              />
            </div>
            {error && <p className="m-0 text-sm text-[#b42318]" role="alert">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="h-11 w-full rounded-[10px] bg-[#1b6b4a] text-white text-[15px] font-bold flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send code
            </button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-[18px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              verifyCode.mutate({ email: email.trim(), code });
            }}
          >
            <h1 className="m-0 text-[22px] font-extrabold">Enter your code</h1>
            <span className="text-sm text-[#3d4c45]">Sent to {email.trim()}</span>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="signin-code" className="text-[13px] font-bold text-[#3d4c45]">6-digit code</label>
              <input
                id="signin-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
                className="h-11 w-full rounded-[10px] border border-[#cfd9d4] px-3.5 text-[15px] font-bold tracking-[0.2em] outline-none focus:border-[#1b6b4a] focus:ring-2 focus:ring-[#1b6b4a]/20"
              />
            </div>
            {error && <p className="m-0 text-sm text-[#b42318]" role="alert">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.replace(/\D/g, "").length !== 6}
              className="h-11 w-full rounded-[10px] bg-[#1b6b4a] text-white text-[15px] font-bold flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setError(null);
              }}
              className="self-start p-0 border-0 bg-transparent text-sm font-bold text-[#1b6b4a] cursor-pointer"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
      <nav aria-label="About LeadDash Employees" className="flex gap-5 text-[13px] font-bold">
        <a href="/about" className="text-[#3d4c45] no-underline hover:underline">About</a>
        <a href="/privacy" className="text-[#3d4c45] no-underline hover:underline">Privacy</a>
        <a href="/terms" className="text-[#3d4c45] no-underline hover:underline">Terms</a>
      </nav>
    </div>
  );
}
