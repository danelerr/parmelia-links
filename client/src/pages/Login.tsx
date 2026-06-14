import { useEffect, useState } from "react";
import {
	signInWithGoogle,
	signInWithApple,
	sendEmailLink,
	isEmailSignInLink,
	completeEmailLink,
} from "../lib/firebase";
import { isUserCancelled, notifyError } from "../lib/notify";
import Logo from "../components/Logo";
import { useTranslation } from "react-i18next";

const APPLE_ENABLED = import.meta.env.VITE_ENABLE_APPLE_LOGIN === "true";

type Mode = "buttons" | "email" | "sent" | "completing" | "need-email";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58Z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.36 1.43c0 1.14-.42 2.2-1.25 3.06-.86.9-1.96 1.4-3.05 1.32a3.5 3.5 0 0 1 1.27-3.05A4.46 4.46 0 0 1 16.36 1.43ZM20.7 17.2c-.5 1.15-.74 1.67-1.38 2.69-.9 1.42-2.17 3.2-3.74 3.21-1.4.02-1.76-.91-3.66-.9-1.9.01-2.29.92-3.69.9-1.57-.01-2.77-1.6-3.67-3.03C1.96 16.2 1.7 11.5 3.26 9c1.1-1.77 2.84-2.8 4.47-2.8 1.66 0 2.71.92 4.08.92 1.34 0 2.15-.92 4.08-.92 1.45 0 2.99.79 4.09 2.16-3.6 1.97-3 7.1.72 8.84Z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

export default function Login() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("buttons");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  // Completing a magic-link return (the link points back here at /login).
  useEffect(() => {
    if (!isEmailSignInLink(window.location.href)) return;
    setMode("completing");
    completeEmailLink(window.location.href)
      .then(() => {
        // onAuthChange in App takes over and redirects.
        window.history.replaceState({}, "", "/login");
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "NEED_EMAIL") {
          setMode("need-email");
        } else {
          notifyError(err, t("login.completeError"));
          setMode("buttons");
        }
      });
  }, []);

  async function handleGoogle() {
    try {
      // null => a redirect was started; onAuthChange completes it on return.
      const credential = await signInWithGoogle();
      if (credential) await credential.user.getIdToken(true);
    } catch (err) {
      if (!isUserCancelled(err)) notifyError(err, t("login.signInError"));
    }
  }

  async function handleApple() {
    try {
      const credential = await signInWithApple();
      if (credential) await credential.user.getIdToken(true);
    } catch (err) {
      if (!isUserCancelled(err)) notifyError(err, t("login.signInError"));
    }
  }

  async function handleSendLink() {
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      notifyError(new Error(t("login.invalidEmail")));
      return;
    }
    setBusy(true);
    try {
      await sendEmailLink(value);
      setMode("sent");
    } catch (err) {
      notifyError(err, t("login.sendError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteWithEmail() {
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      notifyError(new Error(t("login.enterEmailWhereSent")));
      return;
    }
    setBusy(true);
    try {
      await completeEmailLink(window.location.href, value);
      window.history.replaceState({}, "", "/login");
    } catch (err) {
      notifyError(err, t("login.completeError"));
    } finally {
      setBusy(false);
    }
  }

  // ===== Completing / need-email / sent screens =====
  if (mode === "completing") {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center">
        <Logo className="w-16 mb-6 animate-float-glow" />
        <p className="text-[15px] text-text-muted">{t("login.signingIn")}</p>
      </div>
    );
  }

  if (mode === "sent") {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center animate-fade-up">
        <div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 text-glow-sky">
          <MailIcon />
        </div>
        <h1 className="font-display text-[24px] mb-2">{t("login.checkEmailTitle")}</h1>
        <p className="text-[14px] text-text-muted max-w-[300px] leading-relaxed mb-7">
          {t("login.emailSentTo")} <span className="text-text">{email}</span>.{" "}
          {t("login.emailSentOpen")}
        </p>
        <button onClick={() => setMode("buttons")} className="btn-text">
          {t("login.useAnotherMethod")}
        </button>
      </div>
    );
  }

  if (mode === "need-email") {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center animate-fade-up">
        <Logo className="w-14 mb-6" />
        <h1 className="font-display text-[22px] mb-2">{t("login.confirmEmailTitle")}</h1>
        <p className="text-[14px] text-text-muted max-w-[300px] leading-relaxed mb-6">
          {t("login.confirmEmailBody")}
        </p>
        <input
          type="email"
          inputMode="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("login.emailPlaceholder")}
          className="w-full max-w-[320px] bg-surface border border-border rounded-full h-12 px-5 text-[15px] text-text placeholder:text-text-faint text-center focus:border-border-strong transition-colors mb-4"
        />
        <button onClick={handleCompleteWithEmail} disabled={busy} className="btn btn-primary btn-block max-w-[320px]">
          {busy ? t("login.entering") : t("login.enter")}
        </button>
      </div>
    );
  }

  // ===== Main login =====
  return (
    <div className="flex flex-col min-h-dvh px-6 w-full max-w-[460px] mx-auto">
      <div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
        <Logo className="w-24 mb-9 animate-float-glow" />
        <h1 className="font-display text-[34px] leading-[1.06] mb-4 max-w-[300px]">
          {t("login.heroLead")}{" "}
          <span className="text-brand-gradient">{t("login.heroEmphasis")}</span>
        </h1>
        <p className="text-text-muted text-[15px] leading-relaxed max-w-[290px]">
          {t("login.subtitle")}
        </p>
      </div>

      <div
        className="flex flex-col items-center gap-3 animate-fade-up"
        style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      >
        {mode === "email" ? (
          <>
            <input
              type="email"
              inputMode="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendLink()}
              placeholder={t("login.emailPlaceholder")}
              className="w-full bg-surface border border-border rounded-full h-13 px-5 text-[15px] text-text placeholder:text-text-faint text-center focus:border-border-strong transition-colors"
              style={{ height: "3.25rem" }}
            />
            <button onClick={handleSendLink} disabled={busy} className="btn btn-primary btn-block">
              {busy ? t("login.sending") : t("login.sendLink")}
            </button>
            <button onClick={() => setMode("buttons")} className="btn-text">
              {t("common.back")}
            </button>
          </>
        ) : (
          <>
            <button onClick={handleGoogle} className="btn btn-primary btn-block">
              <GoogleIcon />
              {t("login.continueGoogle")}
            </button>
            {APPLE_ENABLED && (
              <button onClick={handleApple} className="btn btn-ghost btn-block">
                <AppleIcon />
                {t("login.continueApple")}
              </button>
            )}
            <button onClick={() => setMode("email")} className="btn btn-ghost btn-block">
              <MailIcon />
              {t("login.continueEmail")}
            </button>
            <p className="text-text-faint text-[13px] mt-1">
              {t("login.noPasswords")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
