// i18n setup. Rule: Spanish browsers load Spanish; ANY other language loads
// English. That means the fallback is English (a French/German/etc. browser is
// not "Spanish", so it must land on English — NOT on the source language).
//
// The chosen language persists in localStorage ("parmelia:lang"); the manual
// selector in Settings overrides detection. The URL is never touched.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import es from "../locales/es.json";
import en from "../locales/en.json";

void i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources: { es: { translation: es }, en: { translation: en } },
		// Anything that isn't Spanish resolves to English.
		fallbackLng: "en",
		supportedLngs: ["es", "en"],
		// es-MX -> es, en-GB -> en, fr-FR -> fr (-> fallback en). We have no
		// regional variants, so collapse to the base language.
		load: "languageOnly",
		detection: {
			order: ["localStorage", "navigator"],
			lookupLocalStorage: "parmelia:lang",
			caches: ["localStorage"],
		},
		interpolation: { escapeValue: false },
		// Resources are bundled (synchronous) — no Suspense fallback needed.
		react: { useSuspense: false },
	});

// Keep <html lang> in sync for a11y / hyphenation. Only ever "es" or "en".
function syncDocumentLang(lng: string) {
	document.documentElement.lang = lng.startsWith("es") ? "es" : "en";
}
syncDocumentLang(i18n.resolvedLanguage || i18n.language || "es");
i18n.on("languageChanged", syncDocumentLang);

export default i18n;
