import { useState } from "react";
import { useTranslation } from "react-i18next";
import MeliSprite, { type MeliSpriteName } from "./MeliSprite";
import { readMigratedStorage, writeStorage } from "../../lib/storageMigration";

const MOOD_KEY = "gatopago:meli-mood";
const LEGACY_MOOD_KEY = "parmelia:meli-mood";

type Mood = "calm" | "curious" | "focused";

const moods: Array<{ id: Mood; sprite: MeliSpriteName }> = [
	{ id: "calm", sprite: "head-happy" },
	{ id: "curious", sprite: "head-curious" },
	{ id: "focused", sprite: "head-focused" },
];

export default function MeliRoom() {
	const { t } = useTranslation();
	const [mood, setMood] = useState<Mood>(() => {
		try {
			const saved = readMigratedStorage(MOOD_KEY, LEGACY_MOOD_KEY);
			return moods.some((item) => item.id === saved) ? saved as Mood : "calm";
		} catch {
			return "calm";
		}
	});
	const selected = moods.find((item) => item.id === mood) ?? moods[0];

	function select(next: Mood) {
		setMood(next);
		try {
			writeStorage(MOOD_KEY, next);
		} catch {
			// This is a cosmetic preference; private browsing may block storage.
		}
	}

	return (
		<section className="meli-paper-card meli-paper-card--strong relative mb-7 overflow-hidden bg-cat-500/[0.06] p-5" aria-labelledby="meli-room-title">
			<div className="absolute right-5 top-0 h-1 w-12 bg-cat-500" aria-hidden="true" />
			<div className="flex items-center gap-4">
				<MeliSprite name={selected.sprite} motion="idle" className="w-20 shrink-0" />
				<div className="min-w-0">
					<p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cat-300">{t("meliRoom.eyebrow")}</p>
					<h2 id="meli-room-title" className="font-display text-[19px]">{t("meliRoom.title")}</h2>
					<p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t("meliRoom.body")}</p>
				</div>
			</div>
			<div className="seg-track seg-track-block mt-4" role="group" aria-label={t("meliRoom.moodAria")}>
				{moods.map((item) => (
					<button key={item.id} type="button" onClick={() => select(item.id)} aria-pressed={mood === item.id} data-active={mood === item.id} className="seg-item px-2">
						{t(`meliRoom.${item.id}`)}
					</button>
				))}
			</div>
		</section>
	);
}
