import { useEffect, useState } from "react";
import {
	signInWithGoogle,
	sendEmailLink,
	isEmailSignInLink,
	completeEmailLink,
} from "../lib/firebase";
import { isUserCancelled, notifyError } from "../lib/notify";
import BrandLockup from "../components/brand/BrandLockup";
import MeliSprite from "../components/brand/MeliSprite";
import PixelRail from "../components/brand/PixelRail";
import { useTranslation } from "react-i18next";
import { writeStorage } from "../lib/storageMigration";

const RECOVER_INTENT_KEY = "gatopago:recover-intent";

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
  const [recoverIntent, setRecoverIntent] = useState(false);

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
  }, [t]);

  async function handleGoogle() {
    try {
      // null => a redirect was started; onAuthChange completes it on return.
      const credential = await signInWithGoogle();
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
      <div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col items-center justify-center px-6 text-center">
        <MeliSprite name="body-courier" className="mb-4 w-36" priority />
        <PixelRail state="active" className="mb-5 max-w-[180px]" />
        <p className="text-[15px] text-text-muted">{t("login.signingIn")}</p>
      </div>
    );
  }

  if (mode === "sent") {
    return (
      <div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col items-center justify-center px-6 text-center animate-fade-up">
        <MeliSprite name="body-peek-card" motion="peek" className="mb-4 w-40" priority />
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
      <div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col items-center justify-center px-6 text-center animate-fade-up">
        <MeliSprite name="head-curious" motion="idle" className="mb-5 w-24" priority />
        <h1 className="font-display text-[22px] mb-2">{t("login.confirmEmailTitle")}</h1>
        <p className="text-[14px] text-text-muted max-w-[300px] leading-relaxed mb-6">
          {t("login.confirmEmailBody")}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCompleteWithEmail();
          }}
          className="w-full max-w-[320px] flex flex-col items-center"
        >
          <label className="mb-4 block w-full text-left text-[13px] text-text-muted">
            <span className="mb-2 block">{t("login.emailLabel")}</span>
            <input
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("login.emailPlaceholder")}
              className="meli-field text-[15px] placeholder:text-text-faint"
            />
          </label>
          <button type="submit" disabled={busy} className="btn btn-primary btn-block">
            {busy ? t("login.entering") : t("login.enter")}
          </button>
        </form>
      </div>
    );
  }

  // ===== Main login =====
  return (
    <div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5">
      <header className="flex shrink-0 justify-center pt-[calc(env(safe-area-inset-top)+1.25rem)] animate-fade-in">
        <BrandLockup compact />
      </header>
      <div className={`flex flex-1 flex-col items-center justify-center text-center animate-fade-up ${mode === "email" ? "py-1" : "py-5"}`}>
		<div className={`meli-login-stage mb-6 ${mode === "email" ? "min-h-[150px]" : "min-h-[205px]"}`}>
			<span aria-hidden="true" />
			<MeliSprite name="body-sitting" motion="idle" className={mode === "email" ? "w-28" : "w-40 sm:w-44"} priority />
		</div>
        <h1 className={`mb-3 max-w-[340px] font-display leading-[1.02] ${mode === "email" ? "text-[28px]" : "text-[34px]"}`}>
          {t("login.heroLead")}{" "}
          <span className="text-cat-300">{t("login.heroEmphasis")}</span>
        </h1>
        <p className="max-w-[330px] text-[14px] leading-relaxed text-text-muted">
          {t("login.subtitle")}
        </p>
      </div>

      <div
        className="flex flex-col items-center gap-3 animate-fade-up"
        style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      >
        {mode === "email" ? (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendLink();
              }}
              className="w-full flex flex-col items-center gap-3"
            >
              <label className="block w-full text-left text-[13px] text-text-muted">
                <span className="mb-2 block">{t("login.emailLabel")}</span>
                <input
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("login.emailPlaceholder")}
                  className="meli-field text-[15px] placeholder:text-text-faint"
                />
              </label>
              <button type="submit" disabled={busy} className="btn btn-primary btn-block">
                {busy ? t("login.sending") : t("login.sendLink")}
              </button>
            </form>
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
            <button onClick={() => setMode("email")} className="btn btn-ghost btn-block">
              <MailIcon />
              {t("login.continueEmail")}
            </button>
            <p className="text-text-faint text-[13px] mt-1">
              {t("login.noPasswords")}
            </p>
            {/* Losing the passkey does NOT lose the account: sign in as usual and
                App redirects to /recover (flag survives the auth roundtrip). */}
            {recoverIntent ? (
              <p className="text-[13px] text-text-muted max-w-[300px] leading-relaxed text-center">
                {t("recover.loginHint")}
              </p>
            ) : (
              <button
                onClick={() => {
                  try {
                    writeStorage(RECOVER_INTENT_KEY, "1");
                  } catch {
                    /* storage unavailable */
                  }
                  setRecoverIntent(true);
                }}
                className="btn-text"
              >
                {t("recover.loginLink")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
