// Support channel (bench B-5): Telegram. The real handle is configured per
// environment (Vercel: VITE_SUPPORT_TELEGRAM_URL); the fallback keeps dev
// builds working.
export const SUPPORT_URL =
	import.meta.env.VITE_SUPPORT_TELEGRAM_URL || "https://t.me/danelerc";
